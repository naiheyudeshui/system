"""Study current/history extractors use only an isolated temporary library."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "study-kb/tools"))
sys.path.insert(0, str(ROOT / "3dStudio/3dworkbench/python"))
import db
from file_assets import FileAssets, FileAssetError
from study_kb import open_db, create_node
from study_knowledge_edit import read_node, save_knowledge_node
from study_library_sync import file_bundles


class StudyReferenceAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.previous = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "study.sqlite"
        self.con = open_db()
        node = create_node(self.con, title="Temporary audit tree", kind="book")
        self.key = "node:" + node["id"]; self.con.commit()
        self.files = FileAssets(db.DB_PATH, workspace_id="study")
        self.files.initialize(); file_bundles(self.files)
        self.asset = self.files.import_stream(io.BytesIO(b"history asset"), 13, "history.bin")["asset"]["assetId"]
        self.second = self.files.import_stream(io.BytesIO(b"current"), 7, "current.bin")["asset"]["assetId"]

    def tearDown(self):
        self.con.close(); db.DB_PATH = self.previous; self.tmp.cleanup()

    def save(self, text):
        return save_knowledge_node({"request_id": str(uuid.uuid4()), "operation": "content", "node_id": self.key,
                                    "version": read_node(self.con, self.key)["version"], "content_md": text})

    def dump(self): return list(self.con.iterdump())

    def test_reconstructs_current_hint_source_and_prior_history_without_business_changes(self):
        self.save(f"[old](wb-asset://{self.asset})")
        self.save(f"[current](wb-asset://{self.second})")
        self.con.execute("UPDATE study_knowledge_item SET hint=?,source_ref=? WHERE id=?", (f"[hint](wb-asset://{self.asset})", f"`wb-asset://{self.second}`", self.key))
        self.con.execute("DELETE FROM wb_file_reference"); self.con.execute("DELETE FROM wb_file_reference_owner"); self.con.commit()
        business_before = list(self.con.execute("SELECT * FROM study_knowledge_item"))
        history_before = list(self.con.execute("SELECT * FROM study_knowledge_edit"))
        before = self.dump(); report = self.files.reference_audit()
        self.assertEqual(before, self.dump()); self.assertTrue(report["canRebuild"])
        self.assertEqual(2, report["assetsChecked"])
        self.files.rebuild_references(report["token"], "study-rebuild")
        self.assertEqual([tuple(r) for r in business_before], [tuple(r) for r in self.con.execute("SELECT * FROM study_knowledge_item")])
        self.assertEqual([tuple(r) for r in history_before], [tuple(r) for r in self.con.execute("SELECT * FROM study_knowledge_edit")])
        active = {r[0] for r in self.con.execute("SELECT asset_id FROM wb_file_reference WHERE owner_kind='study-item' AND owner_id=?", (self.key,))}
        self.assertEqual({self.asset, self.second}, active)
        self.assertGreater(self.con.execute("SELECT count(*) FROM wb_file_reference WHERE owner_kind='study-history' AND asset_id=?", (self.asset,)).fetchone()[0], 0)
        self.assertEqual("study.node-tree", self.files.usage(self.asset)["consumers"][0]["pluginId"])

    def test_invalid_history_blocks_whole_rebuild(self):
        self.save(f"[old](wb-asset://{self.asset})")
        self.con.execute("UPDATE study_knowledge_edit SET before_json='invalid json'"); self.con.commit()
        before = self.dump(); report = self.files.reference_audit()
        self.assertFalse(report["canRebuild"])
        self.assertEqual("invalid-knowledge-history", report["issues"][0]["code"])
        with self.assertRaises(FileAssetError): self.files.rebuild_references(report["token"], "blocked-history")
        self.assertEqual(before, self.dump())

    def test_older_history_format_retains_extra_registered_references(self):
        self.save(f"[old](wb-asset://{self.asset})")
        row = self.con.execute("SELECT request_id FROM study_knowledge_edit").fetchone()
        self.con.execute("UPDATE study_knowledge_edit SET before_json=?", (json.dumps({"content_md": f"[current](wb-asset://{self.second})"}),)); self.con.commit()
        report = self.files.reference_audit()
        self.assertTrue(report["canRebuild"])
        self.assertIn("legacy-history-incomplete", [item["code"] for item in report["issues"]])
        self.files.rebuild_references(report["token"], "legacy-history")
        self.assertEqual({self.asset, self.second}, {r[0] for r in self.con.execute("SELECT asset_id FROM wb_file_reference WHERE owner_kind='study-history' AND owner_id=?", (row[0],))})

    def test_product_scanner_never_reads_study_rows_from_another_workspace(self):
        self.save(f"[secret](wb-asset://{self.asset})")
        other = FileAssets(db.DB_PATH, workspace_id="other"); file_bundles(other)
        report = other.reference_audit()
        self.assertEqual((0, 0), (report["ownersScanned"], report["assetsChecked"]))
        self.assertNotIn(self.asset, json.dumps(report))


if __name__ == "__main__": unittest.main()
