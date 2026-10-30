from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import study_time_resources as resources


class TimerResourceTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys=ON")

    def tearDown(self):
        self.con.close()

    def names(self):
        return {row[0] for row in self.con.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def legacy(self):
        self.con.executescript((ROOT / "schema" / "study_time.sql").read_text(encoding="utf-8"))

    def insert_legacy(self, identifier, kind, status):
        self.con.execute("""INSERT INTO study_time_session(id,timer_kind,task_text,status,started_at,
            last_resumed_at,elapsed_seconds,planned_seconds,project_id,note_text)
            VALUES (?,?,?,?,'2026-10-30T10:00:00+08:00','2026-10-30T10:00:00+08:00',30,?,?,?)""",
            (identifier, kind, "原任务", status, 1500 if kind == "pomodoro" else None,
             "project-original" if kind == "pomodoro" else None, "原备注"))

    def test_each_install_creates_only_its_storage_and_is_idempotent(self):
        stopwatch = resources.ensure_plugin_resources(self.con, "study.stopwatch")
        self.assertNotIn("study_time_session", self.names())
        self.assertFalse(any("pomodoro_" in name for name in self.names()))
        first_names = self.names()
        self.assertEqual(stopwatch, resources.ensure_plugin_resources(self.con, "study.stopwatch"))
        self.assertEqual(self.names(), first_names)
        pomodoro = resources.ensure_plugin_resources(self.con, "study.pomodoro")
        self.assertNotEqual(stopwatch["session"], pomodoro["session"])
        self.assertNotEqual(stopwatch["unit_id"], pomodoro["unit_id"])
        self.assertIn("wbp_study_stopwatch_stopwatch_state_", stopwatch["session"])
        self.assertIn("wbp_study_pomodoro_pomodoro_session_", pomodoro["session"])

    def test_pomodoro_install_does_not_create_stopwatch(self):
        resources.ensure_plugin_resources(self.con, "study.pomodoro")
        self.assertFalse(any("stopwatch_" in name for name in self.names()))

    def test_old_history_preserved_active_stopwatch_only_and_legacy_writes_fenced(self):
        self.legacy()
        self.con.execute("INSERT INTO study_time_project(id,name) VALUES ('project-original','原项目')")
        self.insert_legacy("p-complete", "pomodoro", "completed")
        self.insert_legacy("s-old", "stopwatch", "completed")
        self.insert_legacy("s-active", "stopwatch", "paused")
        self.con.execute("INSERT INTO study_stopwatch_lap VALUES ('lap-active','s-active',1,12,12,'2026-10-30T10:00:12+08:00')")
        self.con.execute("INSERT INTO study_stopwatch_lap VALUES ('lap-old','s-old',1,20,20,'2026-10-30T10:00:20+08:00')")
        old_rows = [tuple(row) for row in self.con.execute("SELECT * FROM study_time_session ORDER BY id")]
        stopwatch = resources.ensure_plugin_resources(self.con, "study.stopwatch")
        pomodoro = resources.ensure_plugin_resources(self.con, "study.pomodoro")
        self.assertEqual(stopwatch["migration"], {"legacy_rows": 2, "copied_rows": 1})
        self.assertEqual([row[0] for row in self.con.execute("SELECT id FROM " + resources.quote(stopwatch["session"]))], ["s-active"])
        self.assertEqual([row[0] for row in self.con.execute("SELECT id FROM " + resources.quote(stopwatch["lap"]))], ["lap-active"])
        migrated = self.con.execute("SELECT * FROM " + resources.quote(pomodoro["session"])).fetchone()
        original = self.con.execute("SELECT * FROM study_time_session WHERE id='p-complete'").fetchone()
        self.assertEqual(tuple(migrated), tuple(original))
        self.assertEqual(self.con.execute("SELECT name FROM " + resources.quote(pomodoro["project"])).fetchone()[0], "原项目")
        self.assertEqual([tuple(row) for row in self.con.execute("SELECT * FROM study_time_session ORDER BY id")], old_rows)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "restart the server"):
            self.con.execute("UPDATE study_time_session SET elapsed_seconds=99 WHERE id='s-active'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "restart the server"):
            self.con.execute("DELETE FROM study_time_project WHERE id='project-original'")
        # A reset of the new stopwatch cannot resurrect retained legacy active rows.
        self.con.execute("DELETE FROM " + resources.quote(stopwatch["session"]))
        again = resources.ensure_plugin_resources(self.con, "study.stopwatch")
        self.assertEqual(self.con.execute("SELECT count(*) FROM " + resources.quote(again["session"])).fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT count(*) FROM " + resources.quote(again["lap"])).fetchone()[0], 0)

    def test_conflicting_legacy_active_rows_roll_back_all_provisioning(self):
        self.legacy()
        self.con.execute("DROP INDEX uq_study_time_active_kind")
        self.insert_legacy("s-one", "stopwatch", "running")
        self.insert_legacy("s-two", "stopwatch", "paused")
        names_before = self.names()
        with self.assertRaisesRegex(ValueError, "多个旧活动计时"):
            resources.ensure_plugin_resources(self.con, "study.stopwatch")
        self.assertEqual(self.names(), names_before)
        self.assertEqual(self.con.execute("SELECT count(*) FROM study_time_session").fetchone()[0], 2)

    def test_registration_failure_rolls_back_ddl_copy_and_fences(self):
        self.legacy()
        self.insert_legacy("s-active", "stopwatch", "paused")
        names_before = self.names()
        with patch.object(resources, "_register", side_effect=ValueError("registry failed")):
            with self.assertRaisesRegex(ValueError, "registry failed"):
                resources.ensure_plugin_resources(self.con, "study.stopwatch")
        self.assertEqual(self.names(), names_before)
        self.con.execute("UPDATE study_time_session SET elapsed_seconds=45 WHERE id='s-active'")
        self.assertEqual(self.con.execute("SELECT elapsed_seconds FROM study_time_session").fetchone()[0], 45)

    def test_stopwatch_database_rejects_completed_history(self):
        stopwatch = resources.ensure_plugin_resources(self.con, "study.stopwatch")
        with self.assertRaises(sqlite3.IntegrityError):
            self.con.execute("INSERT INTO " + resources.quote(stopwatch["session"]) +
                "(id,task_text,status,started_at) VALUES ('bad','秒表','completed','2026-10-30T10:00:00+08:00')")

    def test_an_already_open_old_connection_cannot_write_after_cutover(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "timers.sqlite"
            migrator = sqlite3.connect(path)
            migrator.row_factory = sqlite3.Row
            migrator.executescript((ROOT / "schema" / "study_time.sql").read_text(encoding="utf-8"))
            migrator.execute("INSERT INTO study_time_session(id,timer_kind,task_text,status,started_at) VALUES ('old','stopwatch','秒表','paused','2026-10-30T10:00:00+08:00')")
            migrator.commit()
            old_server = sqlite3.connect(path)
            try:
                self.assertEqual(old_server.execute("SELECT id FROM study_time_session").fetchone()[0], "old")
                migrator.execute("BEGIN IMMEDIATE")
                result = resources.ensure_plugin_resources(migrator, "study.stopwatch")
                migrator.commit()
                with self.assertRaisesRegex(sqlite3.IntegrityError, "restart the server"):
                    old_server.execute("UPDATE study_time_session SET elapsed_seconds=777 WHERE id='old'")
                old_server.rollback()
                self.assertEqual(migrator.execute("SELECT elapsed_seconds FROM " + resources.quote(result["session"])).fetchone()[0], 0)
                self.assertEqual(migrator.execute("SELECT elapsed_seconds FROM study_time_session").fetchone()[0], 0)
            finally:
                old_server.close()
                migrator.close()

    def test_workspaces_have_distinct_stores_and_units(self):
        first = resources.ensure_plugin_resources(self.con, "study.stopwatch")
        second = resources.ensure_plugin_resources(self.con, "study.stopwatch", "another-workspace")
        self.assertNotEqual(first["session"], second["session"])
        self.assertNotEqual(first["unit_id"], second["unit_id"])


if __name__ == "__main__":
    unittest.main()
