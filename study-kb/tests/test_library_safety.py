from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import db
import study_library_sync as library
from study_storage_guard import StorageBusy, connect_guarded, maintenance


class LibrarySafetyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "live.sqlite"
        self.old_path = db.DB_PATH
        db.DB_PATH = self.path
        self.addCleanup(setattr, db, "DB_PATH", self.old_path)
        con = db.connect()
        con.execute("CREATE TABLE sentinel(value TEXT)")
        con.execute("INSERT INTO sentinel VALUES ('before')")
        con.commit()
        con.close()

    def value(self):
        con = db.connect()
        try:
            return con.execute("SELECT value FROM sentinel").fetchone()[0]
        finally:
            con.close()

    def test_failed_staged_migration_does_not_replace_live_or_create_backup(self):
        blob, _ = library.export_library()
        with patch.object(db, "ensure_schema", side_effect=ValueError("adapter failed")):
            with self.assertRaisesRegex(ValueError, "adapter failed"):
                library.import_library(blob)
        self.assertEqual(self.value(), "before")
        self.assertFalse((self.path.parent / "backups").exists())

    def test_foreign_key_corruption_is_rejected_before_publication(self):
        source = self.path.with_name("bad.sqlite")
        source.write_bytes(library.export_library()[0])
        con = sqlite3.connect(source)
        con.executescript("CREATE TABLE p(id PRIMARY KEY); CREATE TABLE c(id REFERENCES p); INSERT INTO c VALUES(1);")
        con.close()
        with self.assertRaisesRegex(ValueError, "外键"):
            library.import_library(source.read_bytes())
        self.assertEqual(self.value(), "before")

    def test_restore_runs_index_adapter_on_stage_and_preserves_backup(self):
        blob, _ = library.export_library()
        con = db.connect()
        con.execute("UPDATE sentinel SET value='later'")
        con.commit()
        con.close()

        def rebuild(con):
            self.assertTrue(con.in_transaction)
            self.assertNotEqual(Path(con.execute("PRAGMA database_list").fetchone()[2]).resolve(), self.path.resolve())
            con.execute("CREATE TABLE restored_index(id TEXT)")
            con.execute("INSERT INTO restored_index VALUES ('rebuilt')")

        with patch.object(library, "_RESTORE_VALIDATORS", [rebuild]):
            result = library.import_library(blob)
        self.assertEqual(self.value(), "before")
        self.assertEqual(result["indexes_rebuilt"], 1)
        backup = sqlite3.connect(self.path.parent / "backups" / result["backup"])
        try:
            self.assertEqual(backup.execute("SELECT value FROM sentinel").fetchone()[0], "later")
        finally:
            backup.close()
        restored = sqlite3.connect(self.path)
        try:
            self.assertEqual(restored.execute("SELECT id FROM restored_index").fetchone()[0], "rebuilt")
        finally:
            restored.close()

    def test_other_process_connection_blocks_maintenance_until_closed(self):
        script = "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from study_storage_guard import connect_guarded; con=connect_guarded(Path(sys.argv[2])); print('ready',flush=True); input(); con.close()"
        process = subprocess.Popen([sys.executable, "-u", "-c", script, str(TOOLS), str(self.path)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            with self.assertRaises(StorageBusy):
                with maintenance(self.path, timeout=0.1):
                    self.fail("must wait for the other process")
            process.communicate("close\n", timeout=5)
            with maintenance(self.path, timeout=0.1):
                con = connect_guarded(self.path)
                con.close()
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_maintenance_blocks_new_connections_in_other_process(self):
        script = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from study_storage_guard import connect_guarded,StorageBusy;\ntry: connect_guarded(Path(sys.argv[2]),timeout=.1)\nexcept StorageBusy: print('blocked')\nelse: raise AssertionError('restore lock bypassed')"
        with maintenance(self.path):
            result = subprocess.run([sys.executable, "-c", script, str(TOOLS), str(self.path)],
                                    capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "blocked")

    def test_reinstall_mode_preserves_saved_plans_and_removes_only_install_state(self):
        con = db.connect()
        con.execute("INSERT INTO workbench_plugin(plugin_id,version,manifest_json,root_path,state) VALUES ('fixture.plugin','1.0.0','{}','fixture','enabled')")
        con.execute("INSERT INTO workbench_plugin_grant(plugin_id,capability,granted) VALUES ('fixture.plugin','read',1)")
        con.execute("CREATE TABLE wb_unit_installation(id TEXT, status TEXT)")
        con.execute("INSERT INTO wb_unit_installation VALUES ('installation','active')")
        con.execute("CREATE TABLE wb_unit_lease(unit_id TEXT)")
        con.execute("INSERT INTO wb_unit_lease VALUES ('old-window')")
        con.commit()
        con.close()
        blob, _ = library.export_library()
        full_restore = library.import_library(blob)
        self.assertFalse(full_restore["reinstall_plugins"])
        con = db.connect()
        try:
            self.assertEqual(con.execute("SELECT state FROM workbench_plugin WHERE plugin_id='fixture.plugin'").fetchone()[0], "enabled")
            self.assertEqual(con.execute("SELECT COUNT(*) FROM workbench_plugin_grant").fetchone()[0], 1)
        finally:
            con.close()
        result = library.import_library(blob, reinstall_plugins=True)
        con = db.connect()
        try:
            self.assertTrue(result["reinstall_plugins"])
            self.assertEqual(con.execute("SELECT state FROM workbench_plugin WHERE plugin_id='fixture.plugin'").fetchone()[0], "disabled")
            self.assertEqual(con.execute("SELECT COUNT(*) FROM workbench_plugin_grant").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT status FROM wb_unit_installation").fetchone()[0], "disabled")
            self.assertEqual(con.execute("SELECT COUNT(*) FROM wb_unit_lease").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT value FROM sentinel").fetchone()[0], "before")
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main()
