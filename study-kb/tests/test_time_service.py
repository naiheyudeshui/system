from __future__ import annotations

from contextlib import closing
import tempfile
import sqlite3
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import study_time_service as service
from db import connect
from study_time_resources import ensure_plugin_resources, quote


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
        con = connect(self.database)
        try:
            resources = ensure_plugin_resources(con, "study.stopwatch")
            for role in ("session", "lap"):
                self.assertEqual(con.execute("SELECT count(*) FROM " + quote(resources[role])).fetchone()[0], 0)
        finally:
            con.close()

    def test_pomodoro_abandon_and_single_active_session(self):
        service.time_action({"kind": "pomodoro", "action": "start", "task_text": "阅读章节", "planned_seconds": 60})
        with self.assertRaisesRegex(ValueError, "已有进行中的计时"):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "重复", "planned_seconds": 60})
        abandoned = service.time_action({"kind": "pomodoro", "action": "abandon"})
        self.assertTrue(abandoned["history"][0]["abandoned"])
        self.assertIsNotNone(abandoned["history"][0]["ended_at"])

    def test_stopwatch_refresh_reset_preserves_pomodoro_and_installation_bindings(self):
        from plugin_units import lease

        instant = datetime.fromisoformat("2026-10-30T12:00:00+08:00")
        with patch.object(service, "_now", return_value=instant):
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "历史番茄", "planned_seconds": 1500})
            service.time_action({"kind": "pomodoro", "action": "complete"})
            service.time_action({"kind": "pomodoro", "action": "start", "task_text": "当前番茄", "planned_seconds": 1500})
            expected = service.time_state("pomodoro")
            service.time_action({"kind": "stopwatch", "action": "start"})
        with patch.object(service, "_now", return_value=instant + timedelta(seconds=12)):
            service.time_action({"kind": "stopwatch", "action": "lap"})
            paused = service.time_action({"kind": "stopwatch", "action": "pause"})
        # Every state call opens a new database connection, matching page refresh.
        with patch.object(service, "_now", return_value=instant + timedelta(seconds=120)):
            restored = service.time_state("stopwatch")
            self.assertEqual(restored["current"], paused["current"])
            self.assertEqual(restored["laps"], paused["laps"])
        con = connect(self.database)
        stopwatch = ensure_plugin_resources(con, "study.stopwatch")
        lease(con, stopwatch["unit_id"], "test-pane")
        bindings_before = [tuple(row) for row in con.execute("SELECT * FROM wb_unit_binding WHERE unit_id=? ORDER BY resource_id", (stopwatch["unit_id"],))]
        con.commit()
        con.close()
        with patch.object(service, "_now", return_value=instant):
            self.assertEqual(service.time_action({"kind": "stopwatch", "action": "reset"})["history"], [])
            self.assertIsNone(service.time_action({"kind": "stopwatch", "action": "reset"})["current"])
            self.assertEqual(service.time_state("pomodoro"), expected)
        con = connect(self.database)
        try:
            self.assertEqual(con.execute("SELECT count(*) FROM wb_unit_lease WHERE unit_id=?", (stopwatch["unit_id"],)).fetchone()[0], 0)
            self.assertEqual([tuple(row) for row in con.execute("SELECT * FROM wb_unit_binding WHERE unit_id=? ORDER BY resource_id", (stopwatch["unit_id"],))], bindings_before)
            self.assertEqual(con.execute("SELECT count(*) FROM " + quote(stopwatch["session"])).fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT count(*) FROM " + quote(stopwatch["lap"])).fetchone()[0], 0)
        finally:
            con.close()

    def test_database_bootstrap_does_not_provision_either_timer(self):
        con = connect(self.database)
        try:
            tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            self.assertFalse(any("pomodoro" in name or "stopwatch" in name or name == "study_time_session" for name in tables))
        finally:
            con.close()

    def test_timer_state_serializes_with_another_startup_writer(self):
        # A timer refresh writes its resource registry. Reproduce another
        # plugin committing after the timer has already read a WAL snapshot.
        service.time_state("pomodoro")
        with closing(sqlite3.connect(self.database)) as con, con:
            con.execute("CREATE TABLE startup_writer_probe(value INTEGER)")
            con.execute("INSERT INTO startup_writer_probe VALUES(0)")
        attempted = False

        def concurrent_resources(con, *args, **kwargs):
            nonlocal attempted
            if attempted:
                return ensure_plugin_resources(con, *args, **kwargs)
            attempted = True
            con.execute("SAVEPOINT startup_snapshot")
            con.execute("SELECT value FROM startup_writer_probe").fetchone()
            with closing(sqlite3.connect(self.database, timeout=0)) as rival, rival:
                try:
                    rival.execute("UPDATE startup_writer_probe SET value=1")
                    rival.commit()
                except sqlite3.OperationalError as error:
                    if "locked" not in str(error):
                        raise
                    rival.rollback()
            result = ensure_plugin_resources(con, *args, **kwargs)
            con.execute("RELEASE SAVEPOINT startup_snapshot")
            return result

        with patch.object(service, "ensure_plugin_resources", side_effect=concurrent_resources):
            state = service.time_state("pomodoro")
        self.assertTrue(attempted)
        self.assertEqual(state["schema"], "study.time/v5")
        with closing(sqlite3.connect(self.database)) as con, con:
            con.execute("UPDATE startup_writer_probe SET value=2")
        self.assertIsNone(service.time_state("pomodoro")["current"])

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
        session = quote(ensure_plugin_resources(con, "study.pomodoro")["session"])
        con.execute(f"""INSERT INTO {session}(
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
        session = quote(ensure_plugin_resources(con, "study.pomodoro")["session"])
        con.execute(f"""INSERT INTO {session}(
            id,timer_kind,task_text,status,planned_seconds,elapsed_seconds,started_at,ended_at
        ) VALUES (?,?,?,?,?,?,?,?)""", (
            "time_morning", "pomodoro", "早起复习", "completed", 1500, 1500,
            "2026-10-14T07:38:01+08:00", "2026-10-14T08:03:01+08:00",
        ))
        con.execute(f"""INSERT INTO {session}(
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
