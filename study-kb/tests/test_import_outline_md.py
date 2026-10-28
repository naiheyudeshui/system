from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from db import connect, init_db  # noqa: E402
from study_outline_md import parse_outline_markdown, parsed_to_import_dict  # noqa: E402
import study_kb  # noqa: E402


SAMPLE_MD = """\
# 测试书 <!-- outline: book -->
## 第1章 <!-- outline: chapter -->
### 什么是 ABSD？ <!-- topic -->
基于架构的软件开发。
#### 四个活动 <!-- outline -->
- 需求
- 设计
"""


class ImportOutlineMdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "study.sqlite"
        init_db(self.database)
        self.con = connect(self.database)

    def tearDown(self) -> None:
        self.con.close()
        self.temp.cleanup()

    def test_parse_outline_markdown(self) -> None:
        roots = parse_outline_markdown(SAMPLE_MD)
        self.assertEqual(1, len(roots))
        self.assertEqual("测试书", roots[0].title)
        chapter = roots[0].children[0]
        topic = chapter.children[0]
        self.assertEqual("topic", topic.role)
        self.assertIn("基于架构", topic.answer_md)
        detail = topic.children[0]
        self.assertEqual("四个活动", detail.title)
        self.assertEqual("topic", detail.role)
        self.assertIn("需求", detail.answer_md)

    def test_import_outline_markdown_syncs_topic_card(self) -> None:
        imported = study_kb.import_outline_markdown(self.con, markdown=SAMPLE_MD, book_title="测试书")
        self.con.commit()
        # Unified model: each outline topic is imported as one schedulable card item.
        parsed_topic = parse_outline_markdown(SAMPLE_MD)[0].children[0].children[0]
        topic_cards = [
            row
            for row in self.con.execute(
                """SELECT i.id, i.title, i.content_md FROM study_knowledge_item i
                   JOIN study_knowledge_schedule f ON f.item_id = i.id
                   WHERE i.item_type = 'card' AND i.status = 'active'"""
            )
        ]
        self.assertGreaterEqual(len(topic_cards), 1)
        card = next((row for row in topic_cards if row["title"] == parsed_topic.title), None)
        self.assertIsNotNone(card)
        self.assertEqual(card["content_md"], parsed_topic.answer_md)
        self.assertEqual(0, self.con.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE item_type = 'topic'").fetchone()[0])
        self.assertIn(imported["scope"]["id"], {row["id"] for row in self.con.execute("SELECT id FROM study_knowledge_scope")})

    def test_parsed_to_import_dict_children(self) -> None:
        roots = parse_outline_markdown(SAMPLE_MD)
        payload = parsed_to_import_dict(roots)
        self.assertTrue(payload[0]["children"])


if __name__ == "__main__":
    unittest.main()
