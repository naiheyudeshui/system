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
        topic_nodes = [
            row
            for row in self.con.execute("SELECT id, role, answer_md FROM study_node WHERE role='topic'")
        ]
        self.assertGreaterEqual(len(topic_nodes), 1)
        topic_id = topic_nodes[0]["id"]
        card = self.con.execute(
            "SELECT front, back FROM study_card WHERE node_id = ? AND status = 'active'",
            (topic_id,),
        ).fetchone()
        self.assertIsNotNone(card)
        self.assertEqual(card["back"], topic_nodes[0]["answer_md"])
        self.assertIn(imported["scope"]["id"], {row["id"] for row in self.con.execute("SELECT id FROM study_scope")})

    def test_parsed_to_import_dict_children(self) -> None:
        roots = parse_outline_markdown(SAMPLE_MD)
        payload = parsed_to_import_dict(roots)
        self.assertTrue(payload[0]["children"])


if __name__ == "__main__":
    unittest.main()
