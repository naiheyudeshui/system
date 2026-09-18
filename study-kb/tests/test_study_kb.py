from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from db import connect, init_db  # noqa: E402
import study_fsrs  # noqa: E402
import study_kb  # noqa: E402


class StudyKbTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "study.sqlite"
        init_db(self.database)
        self.con = connect(self.database)

    def tearDown(self) -> None:
        self.con.close()
        self.temp.cleanup()

    def test_schema_tables(self) -> None:
        tables = {
            row["name"]
            for row in self.con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        expected = (
            "study_node",
            "study_scope",
            "study_card",
            "study_card_fsrs",
            "study_review_log",
        )
        for name in expected:
            self.assertIn(name, tables)

    def test_import_outline_and_fsrs_review(self) -> None:
        imported = study_kb.import_outline(
            self.con,
            book_title="系统分析师教程",
            chapters=[{"title": "第1章 绪论", "sections": [{"title": "1.1 系统与信息系统"}]}],
            source_ref="系统分析师-第二版(OCR).pdf",
        )
        section_id = imported["nodes"][-1]["id"]
        card = study_kb.create_card(
            self.con,
            node_id=section_id,
            front="什么是信息系统？",
            back="由人、硬件、软件、数据、网络等组成的以处理信息流为目标的系统。",
        )
        self.con.commit()

        due_before = study_kb.list_due_cards(self.con, scope_id=imported["scope"]["id"])
        self.assertEqual(1, len(due_before))

        graded = study_kb.grade_card(self.con, card_id=card["id"], rating=3)
        self.con.commit()
        self.assertGreaterEqual(graded["reps"], 1)

    def test_fsrs_new_and_again_paths(self) -> None:
        state = study_fsrs.new_card_state()
        good = study_fsrs.review(state, 3)
        self.assertGreater(good.stability, 0)
        again = study_fsrs.review(good, 1)
        self.assertGreaterEqual(again.lapses, 1)

    def test_topic_node_sync_card(self) -> None:
        topic = study_kb.create_node(
            self.con,
            title="什么是 FSRS？",
            kind="topic",
            role="topic",
            answer_md="Free Spaced Repetition Scheduler。",
        )
        self.con.commit()
        card = self.con.execute(
            "SELECT front, back FROM study_card WHERE node_id = ? AND status = 'active'",
            (topic["id"],),
        ).fetchone()
        self.assertIsNotNone(card)
        self.assertEqual("什么是 FSRS？", card["front"])
        self.assertEqual("Free Spaced Repetition Scheduler。", card["back"])

        study_kb.create_node(self.con, title="outline only", kind="section", role="outline")
        with self.assertRaises(ValueError):
            study_kb.sync_topic_card(self.con, "node_missing")
        outline = study_kb.create_node(self.con, title="章", kind="chapter", role="outline")
        with self.assertRaises(ValueError):
            study_kb.sync_topic_card(self.con, outline["id"])

    def test_build_markmap_markdown(self) -> None:
        book = study_kb.create_node(self.con, title="Book", kind="book", role="outline")
        topic = study_kb.create_node(
            self.con,
            title="Question?",
            kind="topic",
            parent_id=book["id"],
            role="topic",
            answer_md="Answer.",
        )
        study_kb.create_card(
            self.con,
            node_id=topic["id"],
            front="Card sub-question?",
            back="Card answer.",
        )
        self.con.commit()
        md = study_kb.build_markmap_markdown(self.con)
        self.assertIn("# Book", md)
        self.assertIn("node:", md)
        self.assertIn("topic", md)
        self.assertIn("Card sub-question?", md)
        self.assertIn("card:", md)


if __name__ == "__main__":
    unittest.main()
