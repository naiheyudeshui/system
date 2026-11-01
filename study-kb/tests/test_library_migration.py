"""Fictional-library regression coverage for merge, deletion cleanup and APK seeds."""
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "study-kb/tools"))
sys.path.insert(0, str(ROOT / "3dStudio/3dworkbench/python"))
import db
from file_assets import FileAssets
from file_bundles import FileBundles
from study_android_library import pack_library, prepare_initial_library, SEED_TABLE, DATABASE_REL, BUNDLE_REL
from study_kb import open_db, create_node, create_card
from study_library_merge import merge


class LibraryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.target = self.folder / "target.sqlite"
        self.source = self.folder / "phone.sqlite"
        with closing(open_db(self.target)) as con:
            self.root = create_node(con, title="Fictional book", kind="book")
            self.card = create_card(con, node_id=self.root["id"], front="Question", back="Answer")
            con.commit()
            with closing(sqlite3.connect(self.source)) as out:
                con.backup(out)
        self.files = FileAssets(self.target, workspace_id="study")
        self.files.initialize()
        self.asset = self.files.import_stream(io.BytesIO(b"%PDF-1.7\nfixture"), 16, "fixture.pdf")["asset"]["assetId"]

    def test_merge_retains_target_files_and_exact_source_knowledge_without_touching_inputs(self):
        with closing(open_db(self.source)) as con:
            create_node(con, parent_id=self.root["id"], title="New knowledge", kind="topic", role="topic", answer_md="New answer")
            con.execute("UPDATE study_knowledge_item SET content_md='Phone revision' WHERE legacy_card_id=?", (self.card["id"],))
            con.commit()
        hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.source, self.target)]
        output = self.folder / "merged.sqlite"
        report = merge(self.source, self.target, output, source_is_primary=True)
        self.assertTrue(report["allSourceActiveKnowledgeExact"])
        self.assertEqual(hashes, [hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.source, self.target)])
        with closing(sqlite3.connect(output)) as con:
            self.assertEqual(con.execute("SELECT asset_id FROM wb_file_asset").fetchone()[0], self.asset)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM study_library_merge_revision").fetchone()[0], 1)
        repeated = self.folder / "repeated.sqlite"
        report = merge(self.source, output, repeated, source_is_primary=True)
        self.assertEqual(report["tables"]["study_knowledge_item"]["inserted"], 0)
        with self.assertRaises(FileExistsError):
            merge(self.source, self.target, output, source_is_primary=True)

    def test_divergent_edit_branch_is_rejected_and_no_target_data_is_changed(self):
        with closing(sqlite3.connect(self.target)) as con:
            con.execute("INSERT INTO study_knowledge_edit VALUES('local-edit-123','hash','content','{}','{}',CURRENT_TIMESTAMP)")
            con.commit()
        before = self.target.read_bytes()
        with self.assertRaisesRegex(ValueError, "independent knowledge edits"):
            merge(self.source, self.target, self.folder / "failed.sqlite", source_is_primary=True)
        self.assertEqual(before, self.target.read_bytes())

    def test_cleanup_removes_only_confirmed_deletes_and_keeps_suspended_items(self):
        with closing(open_db(self.source)) as con:
            gone = create_node(con, parent_id=self.root["id"], title="Old removed branch", kind="chapter")
            child = create_card(con, node_id=gone["id"], front="Old question", back="Old answer")
            keys = ["node:" + gone["id"], "card:" + child["id"]]
            con.executemany("UPDATE study_knowledge_item SET status='archived' WHERE id=?", [(key,) for key in keys])
            con.execute("INSERT INTO study_knowledge_edit VALUES('old-delete-123','hash','delete','{}',?,CURRENT_TIMESTAMP)", (json.dumps({"node": {"node_id": keys[0], "deleted": True}}),))
            con.execute("UPDATE study_knowledge_item SET status='suspended' WHERE legacy_card_id=?", (self.card["id"],))
            con.commit()
        output = self.folder / "cleaned.sqlite"
        report = merge(self.source, self.target, output, source_is_primary=True, purge_archived_deletions=True)
        self.assertEqual(report["purged"]["knowledgeItems"], 2)
        with closing(sqlite3.connect(output)) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE status='archived'").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE status='suspended'").fetchone()[0], 1)
            self.assertFalse(con.execute("PRAGMA foreign_key_check").fetchall())

    def bundle(self):
        path = self.folder / "library.zip"
        FileBundles(self.files).export(path)
        return path

    def test_complete_personal_seed_hydrates_files_once_and_preserves_later_edits(self):
        archive = self.bundle()
        runtime = self.folder / "runtime"
        copied = {}
        pack_library(archive, runtime, copied)
        self.assertEqual(set(copied), {DATABASE_REL, BUNDLE_REL})
        result = prepare_initial_library(runtime)
        self.assertEqual(result, {"initialized": True, "assets": 1})
        files = FileAssets(runtime / DATABASE_REL, workspace_id="study")
        self.assertEqual(files.content_path(self.asset).read_bytes(), b"%PDF-1.7\nfixture")
        with closing(sqlite3.connect(runtime / DATABASE_REL)) as con:
            con.execute("UPDATE study_knowledge_item SET title='Edited after installation' WHERE legacy_card_id=?", (self.card["id"],))
            con.commit()
        self.assertEqual(prepare_initial_library(runtime)["reason"], "already-complete")
        with closing(sqlite3.connect(runtime / DATABASE_REL)) as con:
            self.assertEqual(con.execute("SELECT title FROM study_knowledge_item WHERE legacy_card_id=?", (self.card["id"],)).fetchone()[0], "Edited after installation")

    def test_existing_installation_never_receives_packaged_library_or_files(self):
        runtime = self.folder / "existing"
        database = runtime / DATABASE_REL
        database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(database)) as con:
            con.execute("CREATE TABLE user_data(value TEXT)")
            con.execute("INSERT INTO user_data VALUES('keep')")
            con.commit()
        before = database.read_bytes()
        self.assertEqual(prepare_initial_library(runtime)["reason"], "existing-installation")
        self.assertEqual(database.read_bytes(), before)
        self.assertFalse(database.with_suffix(".files").exists())

    def test_corrupt_initial_bundle_cannot_publish_a_file_root(self):
        runtime = self.folder / "corrupt"
        pack_library(self.bundle(), runtime, {})
        with (runtime / BUNDLE_REL).open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "differs"):
            prepare_initial_library(runtime)
        self.assertFalse((runtime / DATABASE_REL).with_suffix(".files").exists())

    def test_pending_seed_retries_after_atomic_file_publish(self):
        runtime = self.folder / "retry"
        pack_library(self.bundle(), runtime, {})
        prepare_initial_library(runtime)
        with closing(sqlite3.connect(runtime / DATABASE_REL)) as con:
            con.execute(f"UPDATE {SEED_TABLE} SET state='pending'")
            con.commit()
        self.assertTrue(prepare_initial_library(runtime)["initialized"])

    def test_hardlink_denied_seed_failure_can_retry_without_replacing_database(self):
        runtime = self.folder / "hardlink-denied"
        pack_library(self.bundle(), runtime, {})
        database = runtime / DATABASE_REL
        before = database.read_bytes()
        with patch("file_blob_store.os.rename", side_effect=PermissionError("simulated publish failure")):
            with self.assertRaises(PermissionError):
                prepare_initial_library(runtime)
        self.assertEqual(database.read_bytes(), before)
        self.assertFalse(database.with_suffix(".files").exists())
        with patch("file_blob_store.os.link", side_effect=PermissionError("Android hardlinks denied")) as link:
            result = prepare_initial_library(runtime)
            link.assert_not_called()
        self.assertEqual(result, {"initialized": True, "assets": 1})
        files = FileAssets(database, workspace_id="study")
        self.assertEqual(files.content_path(self.asset).read_bytes(), b"%PDF-1.7\nfixture")
        with closing(sqlite3.connect(database)) as con:
            self.assertEqual(con.execute(f"SELECT state FROM {SEED_TABLE}").fetchone()[0], "complete")


if __name__ == "__main__":
    unittest.main()
