from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from study_kb import create_card, create_node, open_db
from study_review_engine import get_review_session, grade_session, prepare_review, review_catalog


class ReviewEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "review.sqlite"
        self.con = open_db(self.path)
        self.root = create_node(self.con, title="Book", kind="book")
        self.child = create_node(self.con, title="Chapter", kind="chapter", parent_id=self.root["id"])
        self.leaf = create_node(self.con, title="Section", kind="section", parent_id=self.child["id"])
        self.other = create_node(self.con, title="Other", kind="book")
        self.cards = [create_card(self.con, node_id=node["id"], front=front, back=front + " answer", due_at=due)
                      for node, front, due in [
                          (self.child, "A question", "2000-01-01 00:00:00"),
                          (self.leaf, "B question", "2099-01-01 00:00:00"),
                          (self.other, "C question", "2000-01-02 00:00:00"),
                      ]]
        self.con.commit()
        self.patcher = patch("study_review_engine.open_db", lambda: open_db(self.path))
        self.patcher.start()
        self.config = {
            "view": "v_study_node_cards", "mapping": {"key": "card_id", "front": "front", "back": "back", "node": "node_id"},
            "mode": "all", "root_id": self.child["id"], "limit": 100,
            "order": [{"field": "front", "direction": "asc"}], "scheduler": {"kind": "fsrs"},
        }

    def tearDown(self):
        self.patcher.stop()
        self.con.close()
        self.tmp.cleanup()

    def test_catalog_and_preview_do_not_change_scheduling(self):
        before = list(self.con.execute("SELECT * FROM study_card_fsrs"))
        catalog = review_catalog()
        self.assertIn("v_study_node_cards", [view["name"] for view in catalog["views"]])
        preview = prepare_review(self.config, preview=True)
        self.assertEqual((preview["matched"], preview["selected"]), (2, 2))
        self.assertEqual(list(self.con.execute("SELECT * FROM study_card_fsrs")), before)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_review_session").fetchone()[0], 0)

    def test_due_and_all_node_subtree(self):
        self.config["mode"] = "due"
        due = prepare_review(self.config)
        self.assertEqual(due["total"], 1)
        self.config["mode"] = "all"
        all_cards = prepare_review(self.config)
        self.assertEqual(all_cards["total"], 2)
        self.assertEqual(all_cards["card"]["key"], self.cards[0]["id"])

    def test_default_card_answer_falls_back_only_when_empty(self):
        self.con.execute("UPDATE study_node SET answer_md='Fallback' WHERE id=?", (self.child["id"],))
        self.con.commit()
        self.assertEqual(prepare_review(self.config)["card"]["back"], "A question answer")
        self.con.execute("UPDATE study_card SET back='' WHERE id=?", (self.cards[0]["id"],))
        self.con.commit()
        self.assertEqual(prepare_review(self.config)["card"]["back"], "Fallback")

    def test_snapshot_grade_resume_and_idempotency(self):
        session = prepare_review(self.config)
        self.con.execute("UPDATE study_card SET front='Changed question' WHERE id=?", (self.cards[1]["id"],))
        create_card(self.con, node_id=self.child["id"], front="New", back="New", due_at="2000-01-01 00:00:00")
        self.con.commit()
        graded = grade_session(session_id=session["session_id"], position=0, rating=1)
        self.assertEqual(graded["next"]["card"]["front"], "B question")
        self.assertEqual(graded["next"]["total"], 2)
        repeated = grade_session(session_id=session["session_id"], position=0, rating=4)
        self.assertTrue(repeated["replayed"])
        self.assertEqual(repeated["graded"]["due_at"], graded["graded"]["due_at"])
        resumed = get_review_session(session["session_id"])
        self.assertEqual(resumed["completed"], 1)
        finished = grade_session(session_id=session["session_id"], position=1, rating=3)
        self.assertIsNone(finished["next"]["card"])
        self.assertEqual(finished["next"]["completed"], 2)
        self.assertNotEqual(finished["graded"]["due_at"], "2099-01-01 00:00:00")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_review_log").fetchone()[0], 2)
        self.assertEqual(self.con.execute("SELECT due_at FROM study_card_fsrs WHERE card_id=?", (self.cards[2]["id"],)).fetchone()[0], "2000-01-02 00:00:00")

    def test_concurrent_duplicate_grade_updates_once(self):
        session = prepare_review(self.config)
        def submit():
            return grade_session(session_id=session["session_id"], position=0, rating=3)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: submit(), range(2)))
        self.assertEqual(sum(bool(result.get("replayed")) for result in results), 1)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_review_log").fetchone()[0], 1)

    def test_filters_sort_limit_and_empty_collection(self):
        self.config["root_id"] = None
        self.config["filters"] = [{"field": "front", "op": "contains", "value": "question"}, {"field": "front", "op": "gte", "value": "B"}]
        self.config["order"] = [{"field": "front", "direction": "desc"}]
        self.config["limit"] = 1
        preview = prepare_review(self.config, preview=True)
        self.assertEqual(preview["matched"], 2)
        self.assertEqual(preview["sample"][0]["front"], "C question")
        self.config["filters"] = [{"field": "front", "op": "contains", "value": "' OR 1=1 --"}]
        empty = prepare_review(self.config)
        self.assertEqual(empty["total"], 0)
        self.assertIsNone(empty["card"])

    def test_duplicate_view_rows_are_reviewed_once(self):
        self.con.execute("CREATE VIEW duplicated AS SELECT * FROM v_study_node_cards UNION ALL SELECT * FROM v_study_node_cards")
        self.con.commit()
        self.config["view"] = "duplicated"
        self.assertEqual(prepare_review(self.config)["total"], 2)

    def test_random_snapshot_does_not_reshuffle_on_resume(self):
        self.config["random"] = True
        session = prepare_review(self.config)
        self.assertEqual(session, get_review_session(session["session_id"]))
        graded = grade_session(session_id=session["session_id"], position=0, rating=3)
        self.assertNotEqual(session["card"]["key"], graded["next"]["card"]["key"])

    def test_view_intrinsic_due_filter_is_not_removed(self):
        self.config["view"] = "v_study_due_cards"
        self.assertEqual(prepare_review(self.config)["total"], 1)

    def test_invalid_config_rejected(self):
        mutations = [
            {"view": "study_card"}, {"view": 'bad"; DROP TABLE study_card;--'},
            {"mapping": {"key": "card_id", "front": "missing", "back": "back"}},
            {"order": [{"field": "front", "direction": "desc;--"}]},
            {"filters": [{"field": "front", "op": "SQL", "value": "1"}]},
            {"limit": 0}, {"limit": 5001}, {"limit": True}, {"mode": "unknown"}, {"root_id": "missing"},
            {"scheduler": {"kind": "interval", "table": "study_card_fsrs", "key": "card_id", "due": "due_at", "days": [1, 2, 3, 4]}},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                prepare_review({**self.config, **mutation})

    def test_out_of_order_and_invalid_grades_do_not_write(self):
        session = prepare_review(self.config)
        for position, rating, elapsed in [(1, 3, None), (0, 5, None), (0, True, None), (0, 3, -1)]:
            with self.subTest(position=position, rating=rating), self.assertRaises(ValueError):
                grade_session(session_id=session["session_id"], position=position, rating=rating, elapsed_ms=elapsed)
        self.assertEqual(get_review_session(session["session_id"])["completed"], 0)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_review_log").fetchone()[0], 0)

    def test_failed_grade_rolls_back_and_allows_restart(self):
        session = prepare_review(self.config)
        self.con.execute("UPDATE study_card SET status='suspended' WHERE id=?", (session["card"]["key"],))
        self.con.commit()
        with self.assertRaises(ValueError):
            grade_session(session_id=session["session_id"], position=0, rating=3)
        self.assertEqual(get_review_session(session["session_id"])["completed"], 0)
        self.assertEqual(prepare_review(self.config)["total"], 1)

    def custom_config(self):
        self.con.executescript('''
            CREATE TABLE custom_schedule (record_id INTEGER PRIMARY KEY, next_review TEXT, untouched TEXT);
            INSERT INTO custom_schedule VALUES (1, '2000-01-01 00:00:00', 'keep'), (2, '2099-01-01 00:00:00', 'keep');
            CREATE VIEW custom_questions AS SELECT record_id AS identity, 'Prompt' AS prompt, 'Response' AS response FROM custom_schedule;
        ''')
        return {"view": "custom_questions", "mapping": {"key": "identity", "front": "prompt", "back": "response"},
                "mode": "all", "scheduler": {"kind": "interval", "table": "custom_schedule", "key": "record_id", "due": "next_review", "days": [0.01, 1, 3, 7]}}

    def test_custom_fields_and_target_table(self):
        config = self.custom_config()
        catalog = review_catalog()
        self.assertEqual(catalog["targets"][0]["table"], "custom_schedule")
        config["mode"] = "due"
        self.assertEqual(prepare_review(config)["total"], 1)
        config["mode"] = "all"
        session = prepare_review(config)
        self.assertEqual(session["total"], 2)
        self.assertEqual(session["card"]["back"], "Response")
        result = grade_session(session_id=session["session_id"], position=0, rating=3)
        row = self.con.execute("SELECT * FROM custom_schedule WHERE record_id=1").fetchone()
        self.assertEqual(row["next_review"], result["graded"]["due_at"])
        self.assertEqual(row["untouched"], "keep")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM study_review_log").fetchone()[0], 0)

    def test_custom_target_removed_and_invalid_intervals(self):
        config = self.custom_config()
        for intervals in [[1, 2], [0, 1, 2, 3], [1, 2, float("nan"), 4], [1, 2, float("inf"), 4]]:
            invalid = copy.deepcopy(config)
            invalid["scheduler"]["days"] = intervals
            with self.assertRaises(ValueError):
                prepare_review(invalid)
        session = prepare_review(config)
        self.con.execute("DELETE FROM custom_schedule WHERE record_id=1")
        self.con.commit()
        with self.assertRaises(ValueError):
            grade_session(session_id=session["session_id"], position=0, rating=3)
        self.assertEqual(get_review_session(session["session_id"])["completed"], 0)

    def test_quoted_identifiers_and_non_unique_target_rejected(self):
        config = self.custom_config()
        self.con.executescript('''
            CREATE VIEW "quoted view" AS SELECT record_id AS "key value", 'Q' AS "q""field", 'A' AS answer FROM custom_schedule;
            CREATE TABLE bad_target (record_id INTEGER, due TEXT);
        ''')
        config["view"] = "quoted view"
        config["mapping"] = {"key": "key value", "front": 'q"field', "back": "answer"}
        self.assertEqual(prepare_review(config)["total"], 2)
        config["scheduler"]["table"] = "bad_target"
        with self.assertRaises(ValueError):
            prepare_review(config)


if __name__ == "__main__":
    unittest.main()
