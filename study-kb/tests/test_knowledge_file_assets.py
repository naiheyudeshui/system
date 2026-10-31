import io
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "study-kb" / "tools"))
sys.path.insert(0, str(ROOT / "3dStudio" / "3dworkbench" / "python"))
import db
from file_assets import FileAssets, FileAssetError
from study_kb import open_db, create_node
from study_knowledge_edit import read_node, save_knowledge_node


class KnowledgeFileAssets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "study.sqlite"
        self.con = open_db()
        node = create_node(self.con, title="插图知识", kind="book")
        self.key = "node:" + node["id"]
        self.con.commit()
        self.files = FileAssets(db.DB_PATH, workspace_id="study")
        self.files.initialize()
        self.asset = self.files.import_stream(io.BytesIO(b"%PDF-1.7\nfixture"), 16, "manual.pdf", "application/pdf", str(uuid.uuid4()))["asset"]["assetId"]

    def tearDown(self):
        self.con.close()
        db.DB_PATH = self.old_db
        self.tmp.cleanup()

    def payload(self, content):
        return {"request_id": str(uuid.uuid4()), "operation": "content", "node_id": self.key,
                "version": read_node(self.con, self.key)["version"], "content_md": content}

    def test_note_and_history_references_commit_together_and_keep_old_file(self):
        first = self.payload(f"[说明书](wb-asset://{self.asset})")
        save_knowledge_node(first)
        rows = self.con.execute("SELECT owner_kind,owner_id FROM wb_file_reference WHERE asset_id=?", (self.asset,)).fetchall()
        self.assertEqual({row[0] for row in rows}, {"study-item", "study-history"})
        save_knowledge_node(self.payload("不再使用附件"))
        self.assertEqual(self.con.execute("SELECT count(*) FROM wb_file_reference WHERE owner_kind='study-item'").fetchone()[0], 0)
        self.assertGreater(self.con.execute("SELECT count(*) FROM wb_file_reference WHERE owner_kind='study-history'").fetchone()[0], 0)
        self.assertTrue(self.files.content_path(self.asset).is_file())

    def test_missing_asset_rolls_back_content_and_idempotency_receipt(self):
        before = read_node(self.con, self.key)
        payload = self.payload(f"![missing](wb-asset://{uuid.uuid4()})")
        with self.assertRaises(FileAssetError):
            save_knowledge_node(payload)
        self.assertEqual(read_node(self.con, self.key)["version"], before["version"])
        self.assertIsNone(self.con.execute("SELECT 1 FROM study_knowledge_edit WHERE request_id=?", (payload["request_id"],)).fetchone())

    def test_replaying_old_edit_keeps_current_attachment_and_hint_source_fields(self):
        second = self.files.import_stream(io.BytesIO(b"second"), 6, "second.bin")["asset"]["assetId"]
        first = self.payload(f"[old](wb-asset://{self.asset})")
        save_knowledge_node(first)
        save_knowledge_node(self.payload(f"[current](wb-asset://{second})"))
        save_knowledge_node(first)
        active = {row[0] for row in self.con.execute("SELECT asset_id FROM wb_file_reference WHERE owner_kind='study-item' AND owner_id=?", (self.key,))}
        self.assertEqual({second}, active)
        self.con.execute("UPDATE study_knowledge_item SET hint=?,source_ref=? WHERE id=?", (f"![hint](wb-asset://{self.asset})", f"wb-asset://{second}", self.key))
        self.con.commit()
        save_knowledge_node(self.payload("正文无附件"))
        active = {row[0] for row in self.con.execute("SELECT asset_id FROM wb_file_reference WHERE owner_kind='study-item' AND owner_id=?", (self.key,))}
        self.assertEqual({self.asset, second}, active)
        self.assertEqual("study.node-tree", self.files.usage(self.asset)["consumers"][0]["pluginId"])
