from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import db

from study_api import build_node_tree, get_markmap, get_node_detail, grade_review_card, next_review_card
from study_kb import create_card, create_node, create_scope, open_db


class StudyApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "study.sqlite"
        self.con = open_db(self.db_path)
        book = create_node(self.con, title="Test Book", kind="book")
        chapter = create_node(self.con, title="Chapter 1", kind="chapter", parent_id=book["id"])
        create_scope(self.con, anchor_node_id=book["id"], label="Test", is_default=True)
        self.card_a = create_card(self.con, node_id=chapter["id"], front="Q1", back="A1", due_at="2000-01-01 00:00:00")
        self.card_b = create_card(self.con, node_id=chapter["id"], front="Q2", back="A2", due_at="2000-01-02 00:00:00")
        self.con.commit()
        db.DB_PATH = self.db_path

    def tearDown(self) -> None:
        self.con.close()
        self.tmp.cleanup()

    def test_unified_nodes_include_cards_and_scope_without_history_changes(self) -> None:
        from study_api import build_knowledge_tree

        before = [tuple(row) for row in self.con.execute("SELECT * FROM study_card_fsrs ORDER BY card_id")]
        tree = build_knowledge_tree(self.con)
        cards = [row for row in tree["rows"] if row["source_type"] == "card"]
        self.assertEqual(len(cards), 2)
        card = next(row for row in cards if row["source_id"] == self.card_a["id"])
        self.assertEqual(card["title"], "Q1")
        self.assertEqual(card["content_md"], "A1")
        self.assertEqual(card["parent_id"], "node:" + self.card_a["node_id"])
        self.assertEqual(len({row["node_id"] for row in tree["rows"]}), tree["node_count"])
        self.assertEqual(build_knowledge_tree(self.con, scope_id="missing")["node_count"], 0)
        self.con.execute("UPDATE study_card SET status='suspended' WHERE id=?", (self.card_b["id"],))
        self.assertEqual(sum(row["source_type"] == "card" for row in build_knowledge_tree(self.con)["rows"]), 1)
        self.assertEqual(before, [tuple(row) for row in self.con.execute("SELECT * FROM study_card_fsrs ORDER BY card_id")])

    def test_tree_default_upgrade_preserves_custom_sql_and_is_idempotent(self) -> None:
        from study_sql_configs import TREE_DEFAULTS
        from workbench_plugins import seed_configs

        seed_configs(self.con, "study.node-tree", "trees", TREE_DEFAULTS)
        old_sql = "SELECT id AS node_id, parent_id, title, answer_md, sort_order FROM study_node ORDER BY sort_order,title,id"
        self.con.execute("UPDATE workbench_plugin_config SET sql=? WHERE id='study.tree.default.v1'", (old_sql,))
        db.upgrade_knowledge_tree_config(self.con)
        row = self.con.execute("SELECT sql,revision FROM workbench_plugin_config WHERE id='study.tree.default.v1'").fetchone()
        self.assertIn("v_study_knowledge_nodes", row["sql"])
        self.assertEqual(row["revision"], 2)
        db.upgrade_knowledge_tree_config(self.con)
        self.assertEqual(self.con.execute("SELECT revision FROM workbench_plugin_config WHERE id='study.tree.default.v1'").fetchone()[0], 2)
        self.con.execute("UPDATE workbench_plugin_config SET sql=?,revision=3 WHERE id='study.tree.default.v1'", (old_sql,))
        db.upgrade_knowledge_tree_config(self.con)
        self.assertEqual(self.con.execute("SELECT sql FROM workbench_plugin_config WHERE id='study.tree.default.v1'").fetchone()[0], old_sql)

    def test_tree_and_review_flow(self) -> None:
        tree = build_node_tree(self.con)
        self.assertGreaterEqual(tree["node_count"], 2)
        self.assertTrue(tree["roots"])

        nxt = next_review_card()
        self.assertEqual(nxt["card"]["card_id"], self.card_a["id"])

        graded = grade_review_card(card_id=self.card_a["id"], rating=3)
        self.assertNotEqual(graded["graded"]["due_at"], "2000-01-01 00:00:00")
        self.assertEqual(graded["next"]["card"]["card_id"], self.card_b["id"])

    def test_tree_role_fields_and_markmap(self) -> None:
        tree = build_node_tree(self.con)
        chapter = next(node for node in tree["roots"][0]["children"] if node["title"] == "Chapter 1")
        self.assertIn("role", chapter)
        self.assertIn("answer_md", chapter)

        markmap = get_markmap()
        self.assertIn("markdown", markmap)
        self.assertIn("Chapter 1", markmap["markdown"])

        detail = get_node_detail(chapter["id"])
        self.assertEqual(detail["node"]["title"], "Chapter 1")
        self.assertGreaterEqual(len(detail["children"]), 0)

    def test_review_answer_md_enriched(self) -> None:
        self.con.execute(
            "UPDATE study_node SET role='topic', answer_md='node-only-md' WHERE id = ?",
            (self.card_a["node_id"],),
        )
        self.con.commit()
        nxt = next_review_card()
        self.assertEqual(nxt["card"]["answer_md"], "A1")
        self.assertEqual(nxt["card"]["back"], "A1")

    def test_review_uses_node_answer_when_card_back_empty(self) -> None:
        self.con.execute(
            "UPDATE study_card SET back = '' WHERE id = ?",
            (self.card_a["id"],),
        )
        self.con.execute(
            "UPDATE study_node SET role='topic', answer_md='node-fallback-md' WHERE id = ?",
            (self.card_a["node_id"],),
        )
        self.con.commit()
        nxt = next_review_card()
        self.assertEqual(nxt["card"]["answer_md"], "node-fallback-md")


if __name__ == "__main__":
    unittest.main()
