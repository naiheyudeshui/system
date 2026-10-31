"""Portable Study tree/history assets and legacy SQLite compatibility."""
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "study-kb/tools"))
sys.path.insert(0, str(ROOT / "3dStudio/3dworkbench/python"))
import db
import study_library_sync as library
from study_bundle_adapter import ADAPTER, install
from study_kb import create_card, create_node
from file_assets import FileAssets
from file_bundles import FileBundles, BundleError


class StudyBundleTests(unittest.TestCase):
    def test_study_adapter_rejects_foreign_workspace_even_without_attachments(self):
        with closing(db.connect(self.source.db_path)) as connection:
            create_node(connection, title="Private Study node", kind="chapter", node_id="private")
            connection.commit()
        foreign = FileAssets(self.source.db_path, workspace_id="other")
        with self.assertRaisesRegex(BundleError, "Study workspace"):
            FileBundles(foreign).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:private"})
        FileBundles(self.source).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:private"})
        with self.assertRaisesRegex(BundleError, "Study workspace"):
            FileBundles(FileAssets(self.target.db_path, workspace_id="other")).import_bundle(self.archive, request_id="reject-foreign-import")
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.make("source")
        self.target = self.make("target")
        self.archive = self.directory / "portable.zip"
        install()

    def make(self, name):
        path = self.directory / (name + ".sqlite")
        with closing(db.connect(path)) as connection:
            connection.commit()
        files = FileAssets(path, workspace_id="study")
        files.initialize()
        return files

    def populate(self, count=2):
        picture = b"\x89PNG\r\n\x1a\nmanaged picture"
        asset = self.source.import_stream(io.BytesIO(picture), len(picture), "picture.png")["asset"]
        with closing(db.connect(self.source.db_path)) as connection:
            create_node(connection, title="Portable root", kind="chapter", node_id="portable")
            create_node(connection, title="Private unrelated", kind="chapter", node_id="private")
            create_card(connection, node_id="portable", front="Question", back=f"![Picture](wb-asset://{asset['assetId']})", card_id="card-old")
            for index in range(count):
                create_node(connection, title=f"Child {index}", kind="chapter", node_id=f"child-{index}", parent_id="portable")
            connection.execute("INSERT INTO study_knowledge_review_log(id,item_id,rating,reviewed_at,elapsed_ms,before_state_json,after_state_json) VALUES('review-source','card:card-old',3,'2026-01-02 03:04:05',123,'{}','{}')")
            connection.commit()
        return asset

    def test_subtree_full_result_new_ids_history_and_shared_picture(self):
        asset = self.populate(count=5101)
        self.source.save_setting("official.system-theme.default", {"version": 3, "image": {"assetId": asset["assetId"]}}, 0, [asset["assetId"]])
        manifest = FileBundles(self.source).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:portable"})
        self.assertEqual(1, len(manifest["assets"]))
        result = FileBundles(self.target).import_bundle(self.archive, request_id="tree-import-request")
        imported = result["imported"]
        self.assertEqual(5103, imported["counts"]["items"])
        self.assertEqual(1, imported["counts"]["reviewLogs"])
        self.assertNotEqual("node:portable", imported["roots"][0])
        with closing(self.target.connect()) as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM study_knowledge_item WHERE title='Private unrelated'").fetchone())
            root = connection.execute("SELECT parent_id FROM study_knowledge_item WHERE id=?", (imported["roots"][0],)).fetchone()
            self.assertIsNone(root[0])
            child = connection.execute("SELECT parent_id FROM study_knowledge_item WHERE title='Child 5100'").fetchone()
            self.assertEqual(imported["roots"][0], child[0])
            review = connection.execute("SELECT item_id,rating,reviewed_at,elapsed_ms FROM study_knowledge_review_log").fetchone()
            self.assertEqual((imported["recordMap"]["card:card-old"], 3, "2026-01-02 03:04:05", 123), tuple(review))
            content = connection.execute("SELECT content_md FROM study_knowledge_item WHERE item_type='card'").fetchone()[0]
            self.assertIn(result["assetMap"][asset["assetId"]], content)
            self.assertNotIn(asset["assetId"], content)
            self.assertEqual(0, connection.execute("SELECT count(*) FROM wb_file_setting").fetchone()[0])
            self.assertEqual(1, connection.execute("SELECT count(*) FROM wb_file_reference WHERE owner_kind='study-item'").fetchone()[0])

    def test_study_whole_library_gate_and_product_validation(self):
        self.populate()
        with patch.object(db, "DB_PATH", self.source.db_path):
            library.file_bundles(self.source).export(self.archive)
        with patch.object(db, "DB_PATH", self.target.db_path):
            result = library.file_bundles(self.target).import_bundle(self.archive, request_id="whole-library-restore", replace=True)
        self.assertTrue(result["validated"])
        self.assertEqual(self.source.status()["libraryId"], self.target.status()["libraryId"])

    def test_partial_copy_remaps_uppercase_links_preserves_code_examples(self):
        asset = self.populate()
        upper = asset["assetId"].upper()
        uri = "wb-asset://" + upper
        inline = f"`![literal]({uri})`"
        fenced = f"```markdown\n![literal]({uri})\n```"
        content = f"![real]({uri})\n\n{inline}\n\n{fenced}\n"
        hint = f"[actual]({uri}) and `{uri}`"
        with closing(self.source.connect()) as connection:
            connection.execute("UPDATE study_knowledge_item SET content_md=?,hint=?,source_ref=? WHERE id='card:card-old'", (content, hint, uri))
            connection.commit()
        manifest = FileBundles(self.source).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:portable"})
        self.assertEqual([asset["assetId"]], [item["assetId"] for item in manifest["assets"]])
        result = FileBundles(self.target).import_bundle(self.archive, request_id="uppercase-code-copy")
        rewritten = "wb-asset://" + result["assetMap"][asset["assetId"]]
        with closing(self.target.connect()) as connection:
            row = connection.execute("SELECT content_md,hint,source_ref FROM study_knowledge_item WHERE item_type='card'").fetchone()
            self.assertEqual(f"![real]({rewritten})\n\n{inline}\n\n{fenced}\n", row[0])
            self.assertEqual(f"[actual]({rewritten}) and `{uri}`", row[1])
            self.assertEqual(rewritten, row[2])

    def test_code_only_examples_do_not_require_missing_assets(self):
        self.populate()
        uri = "wb-asset://11111111-2222-4333-8444-555555555555"
        content = f"`{uri}`\n\n```markdown\n![example]({uri})\n```\n\n    ![indented]({uri})\n"
        with closing(self.source.connect()) as connection:
            connection.execute("UPDATE study_knowledge_item SET content_md=?,hint=?,source_ref='' WHERE id='card:card-old'", (content, f"`{uri}`"))
            connection.commit()
        manifest = FileBundles(self.source).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:portable"})
        self.assertEqual([], manifest["assets"])
        FileBundles(self.target).import_bundle(self.archive, request_id="code-only-example-copy")
        with closing(self.target.connect()) as connection:
            self.assertEqual(content, connection.execute("SELECT content_md FROM study_knowledge_item WHERE item_type='card'").fetchone()[0])

    def test_real_missing_uppercase_link_blocks_partial_export(self):
        self.populate()
        uri = "wb-asset://11111111-AAAA-4333-8444-555555555555"
        with closing(self.source.connect()) as connection:
            connection.execute("UPDATE study_knowledge_item SET hint=? WHERE id='card:card-old'", (f"![missing]({uri})",))
            connection.commit()
        with self.assertRaisesRegex(BundleError, "attachment is missing"):
            FileBundles(self.source).export(self.archive, scope="unit", adapter=ADAPTER, selection={"id": "node:portable"})
        self.assertFalse(self.archive.exists())

    def test_plain_sqlite_missing_objects_rejected_and_old_database_compatible(self):
        self.populate()
        with patch.object(db, "DB_PATH", self.source.db_path):
            payload, _ = library.export_library()
        with patch.object(db, "DB_PATH", self.target.db_path):
            with self.assertRaisesRegex(BundleError, "complete ZIP"):
                library.import_library(payload)
        # A legacy DB without any file tables is still exchangeable and adopts
        # the live root identity with an empty file index.
        old = self.directory / "old.sqlite"
        with closing(db.connect(old)) as connection:
            connection.commit()
        identity = self.target.status()["libraryId"]
        with patch.object(db, "DB_PATH", self.target.db_path):
            library.import_library(old.read_bytes())
        self.assertEqual(identity, self.target.status()["libraryId"])

    def test_theme_scope_mismatch_is_rejected_before_mutation(self):
        self.populate()
        FileBundles(self.source).export(self.archive)
        before = self.target.status()["libraryId"]
        with self.assertRaisesRegex(BundleError, "scope differs"):
            FileBundles(self.target).import_bundle(self.archive, request_id="theme-only-import", replace=True, expected_scope="theme")
        self.assertEqual(before, self.target.status()["libraryId"])

    def test_apk_seed_rejects_missing_file_root_and_accepts_legacy_clean_seed(self):
        import assemble_android_assets as assembler
        output = self.directory / "runtime"
        with patch.object(assembler, "DEST_ROOT", output):
            with self.assertRaisesRegex(RuntimeError, "clean seed database"):
                assembler._copy_database(self.source.db_path, {})
            self.assertFalse(output.exists())
            old = self.directory / "seed.sqlite"
            with closing(sqlite3.connect(old)) as connection:
                connection.execute("CREATE TABLE fixture(id)")
                connection.commit()
            copied = {}
            assembler._copy_database(old, copied)
            self.assertTrue((output / assembler.SQLITE_REL).is_file())
            self.assertIn(assembler.SQLITE_REL, copied)


if __name__ == "__main__":
    unittest.main()
