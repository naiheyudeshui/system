from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta
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

    def test_stopwatch_pause_resume_lap_and_reset(self):
        started = service.time_action({"kind": "stopwatch", "action": "start"})
        self.assertEqual(started["current"]["status"], "running")
        lap_at = service._parse(started["current"]["started_at"]) + timedelta(seconds=12)
        with patch.object(service, "_now", return_value=lap_at):
            lap = service.time_action({"kind": "stopwatch", "action": "lap"})
        self.assertEqual(lap["laps"][0]["lap_number"], 1)
        self.assertEqual(lap["laps"][0]["total_seconds"], 12)
        paused = service.time_action({"kind": "stopwatch", "action": "pause"})
        self.assertEqual(paused["current"]["status"], "paused")
        resumed = service.time_action({"kind": "stopwatch", "action": "resume"})
        self.assertEqual(resumed["current"]["status"], "running")
        service.time_action({"kind": "stopwatch", "action": "pause"})
        reset = service.time_action({"kind": "stopwatch", "action": "reset"})
        self.assertIsNone(reset["current"])
        self.assertEqual(reset["laps"], [])

    def test_pomodoro_abandon_and_single_active_session(self):
        service.time_action({"kind": "pomodoro", "action": "start", "task_text": "阅读章节", "planned_seconds": 60})
        with self.assertRaisesRegex(ValueError, "已有进行中的计时"):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "重复", "planned_seconds": 60})
        abandoned = service.time_action({"kind": "pomodoro", "action": "abandon"})
        self.assertTrue(abandoned["history"][0]["abandoned"])
        self.assertIsNotNone(abandoned["history"][0]["ended_at"])

    def test_pomodoro_default_task_history_edit_and_chart_aggregates(self):
        started = service.time_action({"kind": "pomodoro", "action": "start", "task_text": "", "planned_seconds": 60})
        self.assertRegex(started["current"]["task_text"], r"^番茄钟 · \d{2}-\d{2} \d{2}:\d{2}$")
        completed = service.time_action({"kind": "pomodoro", "action": "complete"})
        session_id = completed["history"][0]["id"]
        updated = service.time_action({"kind": "pomodoro", "action": "update", "id": session_id, "task_text": "整理错题", "note_text": "注意概念边界", "project_id": None})
        self.assertEqual(updated["history"][0]["task_text"], "整理错题")
        self.assertEqual(updated["history"][0]["note_text"], "注意概念边界")
        self.assertIn("days", updated["summary"]["charts"])
        self.assertIn("todayHours", updated["summary"]["charts"])
        self.assertIn("todayProjects", updated["summary"]["charts"])
        self.assertIn("weekProjects", updated["summary"]["charts"])

    def test_projects_and_summary_preserve_history(self):
        projects = service.project_action({"action": "save", "name": "考试复习", "color": "#336699"})["projects"]
        project_id = projects[0]["id"]
        started = service.time_action({"kind": "pomodoro", "action": "start", "task_text": "复习需求工程", "project_id": project_id, "planned_seconds": 60})
        self.assertEqual(started["current"]["project_name"], "考试复习")
        completed = service.time_action({"kind": "pomodoro", "action": "complete"})
        self.assertEqual(completed["history"][0]["project_id"], project_id)
        self.assertEqual(completed["summary"]["today"]["completed"], 1)
        service.project_action({"action": "archive", "id": project_id})
        state = service.time_state("pomodoro")
        self.assertEqual(state["projects"][0]["status"], "archived")
        self.assertEqual(state["history"][0]["project_name"], "考试复习")

    def test_today_hours_use_shanghai_time_and_split_across_hour_boundaries(self):
        now = datetime.fromisoformat("2026-09-30T12:00:00+08:00")
        con = connect(self.database)
        con.execute("""INSERT INTO study_time_session(
            id,timer_kind,task_text,status,planned_seconds,elapsed_seconds,started_at,ended_at
        ) VALUES (?,?,?,?,?,?,?,?)""", (
            "time_split", "pomodoro", "跨小时复习", "completed", 1800, 1800,
            "2026-09-30T04:48:00+08:00", "2026-09-30T05:18:00+08:00",
        ))
        con.commit()
        with patch.object(service, "_now", return_value=now):
            summary = service._summary(con, "pomodoro", now)
        con.close()
        self.assertEqual(summary["charts"]["todayHours"], [
            {"label": "04:00", "hour": 4, "seconds": 720},
            {"label": "05:00", "hour": 5, "seconds": 1080},
        ])

    def test_last_pomodoro_duration_is_returned_as_preference(self):
        service.time_action({"kind": "pomodoro", "action": "start", "task_text": "四十分钟", "planned_seconds": 2400})
        state = service.time_action({"kind": "pomodoro", "action": "complete"})
        self.assertEqual(state["preferences"]["planned_seconds"], 2400)

    def test_today_summary_includes_morning_sessions_before_utc_midnight(self):
        """ISO +08:00 早上会话在 SQLite date(ts) 下会落到昨天，必须用 localtime。"""
        now = datetime.fromisoformat("2026-10-14T10:00:00+08:00")
        con = connect(self.database)
        con.execute("""INSERT INTO study_time_session(
            id,timer_kind,task_text,status,planned_seconds,elapsed_seconds,started_at,ended_at
        ) VALUES (?,?,?,?,?,?,?,?)""", (
            "time_morning", "pomodoro", "早起复习", "completed", 1500, 1500,
            "2026-10-14T07:38:01+08:00", "2026-10-14T08:03:01+08:00",
        ))
        con.execute("""INSERT INTO study_time_session(
            id,timer_kind,task_text,status,planned_seconds,elapsed_seconds,started_at,ended_at
        ) VALUES (?,?,?,?,?,?,?,?)""", (
            "time_noon", "pomodoro", "午间复习", "completed", 1500, 1500,
            "2026-10-14T09:00:00+08:00", "2026-10-14T09:25:00+08:00",
        ))
        con.commit()
        summary = service._summary(con, "pomodoro", now)
        con.close()
        self.assertEqual(summary["today"]["completed"], 2)
        self.assertEqual(summary["today"]["seconds"], 3000)

    def test_expired_running_pomodoro_is_reconciled_and_counted(self):
        started_at = datetime.fromisoformat("2026-10-13T08:00:00+08:00")
        with patch.object(service, "_now", return_value=started_at):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "第一项", "planned_seconds": 1800})
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=1800)):
            service.time_state("pomodoro")
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=1801)):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "第二项", "planned_seconds": 1800})
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=3601)):
            service.time_state("pomodoro")
        # Simulate the third countdown reaching zero while the browser is
        # backgrounded: no client-side complete action is sent.
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=5401)):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "第三项", "planned_seconds": 1800})
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=7201)):
            state = service.time_state("pomodoro")
        self.assertIsNone(state["current"])
        self.assertEqual(state["summary"]["today"]["completed"], 3)
        self.assertEqual(state["summary"]["today"]["seconds"], 5400)

    def test_client_complete_after_expiry_is_idempotent(self):
        # Frontend paint() posts complete at zero; _finish_expired may already
        # have closed the session in the same request — must not error/rollback.
        started_at = datetime.fromisoformat("2026-10-14T17:04:00+08:00")
        with patch.object(service, "_now", return_value=started_at):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "番茄钟 · 10-14 17:04", "planned_seconds": 1500})
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=1500)):
            state = service.time_action({"kind": "pomodoro", "action": "complete"})
        self.assertIsNone(state["current"])
        self.assertEqual(state["summary"]["today"]["completed"], 1)
        self.assertEqual(state["summary"]["today"]["seconds"], 1500)
        with patch.object(service, "_now", return_value=started_at + timedelta(seconds=1501)):
            again = service.time_action({"kind": "pomodoro", "action": "complete"})
        self.assertIsNone(again["current"])
        self.assertEqual(again["summary"]["today"]["completed"], 1)


if __name__ == "__main__":
    unittest.main()
