from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import study_time_service as service
from db import connect


class StudyTimeServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "time.sqlite"
        self.connect_patch = patch.object(service, "connect", lambda: connect(self.database))
        self.connect_patch.start()

    def tearDown(self):
        self.connect_patch.stop()
        self.temp.cleanup()

    def test_stopwatch_pause_resume_complete_and_history(self):
        started = service.time_action({"kind": "stopwatch", "action": "start", "task_text": "整理知识卡"})
        self.assertEqual(started["current"]["status"], "running")
        paused = service.time_action({"kind": "stopwatch", "action": "pause"})
        self.assertEqual(paused["current"]["status"], "paused")
        resumed = service.time_action({"kind": "stopwatch", "action": "resume"})
        self.assertEqual(resumed["current"]["status"], "running")
        completed = service.time_action({"kind": "stopwatch", "action": "complete"})
        self.assertIsNone(completed["current"])
        self.assertEqual(completed["history"][0]["task_text"], "整理知识卡")
        self.assertFalse(completed["history"][0]["abandoned"])

    def test_pomodoro_abandon_and_single_active_session(self):
        service.time_action({"kind": "pomodoro", "action": "start", "task_text": "阅读章节", "planned_seconds": 60})
        with self.assertRaisesRegex(ValueError, "已有进行中的计时"):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "重复", "planned_seconds": 60})
        abandoned = service.time_action({"kind": "pomodoro", "action": "abandon"})
        self.assertTrue(abandoned["history"][0]["abandoned"])
        self.assertIsNotNone(abandoned["history"][0]["ended_at"])

    def test_projects_and_summary_preserve_history(self):
        projects = service.project_action({"action": "save", "name": "考试复习", "color": "#336699"})["projects"]
        project_id = projects[0]["id"]
        started = service.time_action({"kind": "stopwatch", "action": "start", "task_text": "复习需求工程", "project_id": project_id})
        self.assertEqual(started["current"]["project_name"], "考试复习")
        completed = service.time_action({"kind": "stopwatch", "action": "complete"})
        self.assertEqual(completed["history"][0]["project_id"], project_id)
        self.assertEqual(completed["summary"]["today"]["completed"], 1)
        service.project_action({"action": "archive", "id": project_id})
        state = service.time_state("stopwatch")
        self.assertEqual(state["projects"][0]["status"], "archived")
        self.assertEqual(state["history"][0]["project_name"], "考试复习")


if __name__ == "__main__":
    unittest.main()
