import tempfile
import unittest
import uuid
from pathlib import Path

import db
from study_kb import open_db, create_node, create_card, create_scope, grade_card
from study_knowledge_edit import read_node, save_knowledge_node, KnowledgeConflict
from study_api import build_knowledge_tree


class KnowledgeEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "study.sqlite"
        self.old_path = db.DB_PATH
        db.DB_PATH = self.path
        self.con = open_db(self.path)
        self.root = create_node(self.con, title="Root", kind="book")
        self.card = create_card(self.con, node_id=self.root["id"], front="Question", back="Original")
        self.scope = create_scope(self.con, anchor_node_id=self.root["id"], label="Scope")
        self.con.commit()

    def tearDown(self):
        self.con.close()
        db.DB_PATH = self.old_path
        self.temp.cleanup()

    def payload(self, key, operation, **values):
        return {"request_id": str(uuid.uuid4()), "node_id": key, "operation": operation,
                "version": read_node(self.con, key)["version"], "title": "New topic", "content_md": "**Body**", **values}

    def test_child_sibling_card_parent_scope_and_no_automatic_cards(self):
        root_key = "node:" + self.root["id"]
        card_key = "card:" + self.card["id"]
        child = save_knowledge_node(self.payload(card_key, "child"))["node"]
        self.assertEqual(child["parent_id"], card_key)
        self.assertEqual(child["owner_node_id"], child["source_id"])
        self.assertEqual(self.con.execute("SELECT parent_id FROM study_node WHERE id=?", (child["source_id"],)).fetchone()[0], self.root["id"])
        sibling = save_knowledge_node(self.payload(child["node_id"], "sibling"))["node"]
        self.assertEqual(sibling["parent_id"], card_key)
        root_sibling = save_knowledge_node(self.payload(root_key, "sibling"))["node"]
        self.assertIsNone(root_sibling["parent_id"])
        card_sibling = save_knowledge_node(self.payload(card_key, "sibling"))["node"]
        self.assertEqual(card_sibling["parent_id"], root_key)
        scoped = build_knowledge_tree(self.con, scope_id=self.scope["id"])
        self.assertIn(child["node_id"], [row["node_id"] for row in scoped["rows"]])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_card").fetchone()[0], 1)
        self.assertFalse(self.con.execute("PRAGMA foreign_key_check").fetchall())

    def test_content_idempotency_conflict_and_history(self):
        grade_card(self.con, card_id=self.card["id"], rating=3)
        self.con.commit()
        logs = [tuple(row) for row in self.con.execute("SELECT * FROM study_review_log")]
        before = [tuple(row) for row in self.con.execute("SELECT * FROM study_card_fsrs")]
        payload = self.payload("card:" + self.card["id"], "content", content_md="")
        result = save_knowledge_node(payload)
        self.assertEqual(result["node"]["content_md"], "")
        self.assertEqual(save_knowledge_node(payload), result)
        with self.assertRaises(KnowledgeConflict):
            save_knowledge_node({**payload, "request_id": str(uuid.uuid4()), "content_md": "stale"})
        with self.assertRaises(KnowledgeConflict):
            save_knowledge_node({**payload, "content_md": "different"})
        self.assertEqual(before, [tuple(row) for row in self.con.execute("SELECT * FROM study_card_fsrs")])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_knowledge_edit").fetchone()[0], 1)
        self.assertEqual(logs, [tuple(row) for row in self.con.execute("SELECT * FROM study_review_log")])

    def test_invalid_input_and_suspended_card_do_not_write(self):
        payload = self.payload("node:" + self.root["id"], "child", title=" ")
        with self.assertRaises(ValueError): save_knowledge_node(payload)
        payload = self.payload("card:" + self.card["id"], "child")
        self.con.execute("UPDATE study_card SET status='suspended' WHERE id=?", (self.card["id"],))
        self.con.commit()
        with self.assertRaises(ValueError): save_knowledge_node(payload)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_node").fetchone()[0], 1)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_knowledge_edit").fetchone()[0], 0)

    def test_repeated_create_and_inactive_card_parent_fallback(self):
        payload = self.payload("card:" + self.card["id"], "child")
        child = save_knowledge_node(payload)
        self.assertEqual(save_knowledge_node(payload), child)
        self.con.execute("UPDATE study_card SET status='suspended' WHERE id=?", (self.card["id"],))
        self.con.commit()
        updated = read_node(self.con, child["node"]["node_id"])
        self.assertEqual(updated["node"]["parent_id"], "node:" + self.root["id"])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_node").fetchone()[0], 2)

    def test_overdepth_create_rolls_back_node_and_audit(self):
        parent_id = self.root["id"]
        for depth in range(255):
            parent_id = create_node(self.con, title=f"Level {depth}", kind="topic", parent_id=parent_id)["id"]
        self.con.commit()
        payload = self.payload("node:" + parent_id, "child")
        with self.assertRaises(ValueError): save_knowledge_node(payload)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_node").fetchone()[0], 256)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_knowledge_edit").fetchone()[0], 0)
