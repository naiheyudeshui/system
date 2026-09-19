from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"))

from tree_model import tree_result


class TreeModelTests(unittest.TestCase):
    def result(self, rows, **extra):
        return {"columns": ["node_id", "parent_id", "title", "answer_md"], "rows": rows, "truncated": False, **extra}

    def node(self, key, parent=None, title="Title"):
        return {"node_id": key, "parent_id": parent, "title": title, "answer_md": "**Answer**"}

    def test_custom_mapping_and_multiple_detail_modules(self):
        result = {"columns": ["code", "owner", "label", "body", "source"], "rows": [{"code": 1, "owner": None, "label": "Root", "body": "# Detail", "source": "Book"}, {"code": "two", "owner": 1.0, "label": "Child", "body": "Text", "source": "Note"}], "truncated": False}
        settings = {"tree": {"id": "code", "parent": "owner", "title": "label", "details": [{"column": "body", "label": "Explanation", "format": "markdown"}, {"column": "source", "format": "text"}]}}
        tree = tree_result(result, settings)
        self.assertEqual(tree["validation"]["kind"], "tree")
        self.assertEqual(tree["roots"][0]["children"][0]["parent_id"], "1")
        self.assertEqual(tree["rows"][0]["detail_2"], "Book")
        self.assertEqual(len(tree["detail_fields"]), 2)
        self.assertEqual(tree["validation"]["max_depth"], 2)

    def test_forests_empty_and_orphan_policy(self):
        self.assertEqual(tree_result(self.result([]))["validation"]["kind"], "empty")
        tree = tree_result(self.result([self.node("a"), self.node("b")]))
        self.assertEqual(tree["validation"]["kind"], "forest")
        with self.assertRaisesRegex(ValueError, "父节点"):
            tree_result(self.result([self.node("a", "missing")]))
        tree = tree_result(self.result([self.node("a", "missing")]), {"tree": {"orphans": "root"}})
        self.assertEqual(len(tree["validation"]["warnings"]), 1)
        self.assertIsNone(tree["roots"][0]["parent_id"])

    def test_invalid_ids_titles_cycles_and_duplicate_parents(self):
        cases = [[self.node(None)], [self.node(" ")], [self.node(True)], [self.node(float("inf"))], [self.node(1), self.node("1")], [self.node("a", "a")], [self.node("a", "b"), self.node("b", "a")], [self.node("a", title=" ")], [self.node("a"), self.node("a", "b")]]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                tree_result(self.result(rows))

    def test_bounds_and_invalid_mapping(self):
        for result in [self.result([self.node("a")], truncated=True), self.result([self.node(index, index - 1 if index else None) for index in range(257)]), self.result([self.node(index) for index in range(5001)])]:
            with self.assertRaises(ValueError):
                tree_result(result)
        for settings in [{"tree": {"id": "missing"}}, {"tree": {"parent": "node_id"}}, {"tree": {"details": [{"column": "missing"}]}}, {"tree": {"details": [{"column": "answer_md", "format": "html"}]}}, {"tree": {"orphans": "ignore"}}]:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                tree_result(self.result([self.node("a")]), settings)
        deep = tree_result(self.result([self.node(index, index - 1 if index else None) for index in range(256)]))
        self.assertEqual(deep["validation"]["max_depth"], 256)
