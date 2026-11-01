"""Persistent Pomodoro and stopwatch sessions for upper-bar plugins."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from db import connect
from study_time_resources import ensure_plugin_resources, quote

KINDS = {"pomodoro", "stopwatch"}
ACTIONS = {"start", "pause", "resume", "complete", "abandon", "update"}
STOPWATCH_ACTIONS = {"start", "pause", "resume", "lap", "reset"}
PROJECT_ACTIONS = {"save", "archive", "restore"}
STUDY_TIMEZONE = timezone(timedelta(hours=8), "Asia/Shanghai")


def _now() -> datetime:
    return datetime.now(STUDY_TIMEZONE)


def _stamp(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=STUDY_TIMEZONE) if parsed.tzinfo is None else parsed.astimezone(STUDY_TIMEZONE)


def _today_hour_distribution(con, kind: str, now: datetime) -> list[dict]:
    session = quote(ensure_plugin_resources(con, "study." + kind)["session"])
    day_start = now.astimezone(STUDY_TIMEZONE).replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    seconds_by_hour: dict[int, int] = {}
    rows = con.execute(f"""SELECT started_at,elapsed_seconds FROM {session}
        WHERE timer_kind=? AND status IN ('completed','abandoned')""", (kind,))
    for row in rows:
        started = _parse(row["started_at"])
        elapsed = max(0, int(row["elapsed_seconds"] or 0))
        if not started or not elapsed:
            continue
        ended = started + timedelta(seconds=elapsed)
        cursor = max(started, day_start)
        effective_end = min(ended, day_end)
        while cursor < effective_end:
            next_hour = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            segment_end = min(effective_end, next_hour)
            seconds_by_hour[cursor.hour] = seconds_by_hour.get(cursor.hour, 0) + int((segment_end - cursor).total_seconds())
            cursor = segment_end
    return [{"label": f"{hour:02d}:00", "hour": hour, "seconds": seconds_by_hour[hour]} for hour in sorted(seconds_by_hour)]


def _elapsed(row, now: datetime) -> int:
    elapsed = int(row["elapsed_seconds"] or 0)
    resumed = _parse(row["last_resumed_at"])
    if row["status"] == "running" and resumed:
        elapsed += max(0, int((now - resumed).total_seconds()))
    return elapsed


def _serialize(row, now: datetime) -> dict:
    item = dict(row)
    item["elapsed_seconds"] = _elapsed(row, now)
    if item["timer_kind"] == "pomodoro" and item["planned_seconds"]:
        item["remaining_seconds"] = max(0, item["planned_seconds"] - item["elapsed_seconds"])
    else:
        item["remaining_seconds"] = None
    item["abandoned"] = bool(item["abandoned"])
    return item


def _projects(con) -> list[dict]:
    project = quote(ensure_plugin_resources(con, "study.pomodoro")["project"])
    return [dict(row) for row in con.execute(f"SELECT * FROM {project} ORDER BY status,name COLLATE NOCASE")]


def _summary(con, kind: str, now: datetime) -> dict:
    resources = ensure_plugin_resources(con, "study." + kind)
    session, project = quote(resources["session"]), quote(resources["project"])
    # started_at 存的是带 +08:00 的 ISO。SQLite date(ts) 会先按 UTC 取日，
    # 导致北京时间 08:00 前的会话被算进昨天；必须用 date(ts,'localtime')。
    # 今日边界以 Python 的 Asia/Shanghai now 为准，避免 SQL date('now') 与业务时钟漂移。
    # 今日专注只统计已完成/已放弃，与「已完成/已放弃」次数口径一致（不含进行中）。
    local = now.astimezone(STUDY_TIMEZONE)
    today = local.date().isoformat()
    week_start = (local.date() - timedelta(days=6)).isoformat()
    totals = con.execute(f"""SELECT COALESCE(SUM(CASE WHEN status IN ('completed','abandoned') THEN elapsed_seconds ELSE 0 END),0) seconds,
        SUM(status='completed') completed, SUM(status='abandoned') abandoned
        FROM {session} WHERE timer_kind=? AND date(started_at,'localtime')=?""", (kind, today)).fetchone()
    days = [dict(row) for row in con.execute(f"""WITH RECURSIVE dates(day) AS (
        SELECT ? UNION ALL SELECT date(day,'+1 day') FROM dates WHERE day<?)
        SELECT dates.day,COALESCE(SUM(s.elapsed_seconds),0) seconds FROM dates
        LEFT JOIN {session} s ON date(s.started_at,'localtime')=dates.day AND s.timer_kind=? AND s.status IN ('completed','abandoned')
        GROUP BY dates.day ORDER BY dates.day""", (week_start, today, kind))]
    projects = [dict(row) for row in con.execute(f"""SELECT p.id,p.name,p.color,COALESCE(SUM(s.elapsed_seconds),0) seconds
        FROM {project} p LEFT JOIN {session} s ON s.project_id=p.id AND s.timer_kind=? AND s.status IN ('completed','abandoned')
        GROUP BY p.id,p.name,p.color HAVING seconds>0 ORDER BY seconds DESC,p.name LIMIT 12""", (kind,))]
    today_hours = _today_hour_distribution(con, kind, now)
    today_projects = [dict(row) for row in con.execute(f"""SELECT COALESCE(p.id,'') id,COALESCE(p.name,'无项目') label,
        COALESCE(p.color,'#7f9f90') color,SUM(s.elapsed_seconds) seconds FROM {session} s
        LEFT JOIN {project} p ON p.id=s.project_id WHERE s.timer_kind=? AND s.status IN ('completed','abandoned')
        AND date(s.started_at,'localtime')=? GROUP BY p.id,p.name,p.color ORDER BY seconds DESC""", (kind, today))]
    week_projects = [dict(row) for row in con.execute(f"""SELECT COALESCE(p.id,'') id,COALESCE(p.name,'无项目') label,
        COALESCE(p.color,'#7f9f90') color,SUM(s.elapsed_seconds) seconds FROM {session} s
        LEFT JOIN {project} p ON p.id=s.project_id WHERE s.timer_kind=? AND s.status IN ('completed','abandoned')
        AND date(s.started_at,'localtime')>=? GROUP BY p.id,p.name,p.color ORDER BY seconds DESC""", (kind, week_start))]
    return {"today": dict(totals), "days": days, "projects": projects, "charts": {"days": days, "todayHours": today_hours, "todayProjects": today_projects, "weekProjects": week_projects}}


def _finish_expired(con, kind: str, now: datetime) -> None:
    if kind != "pomodoro":
        return
    session = quote(ensure_plugin_resources(con, "study.pomodoro")["session"])
    # Reconcile every expired running session before returning state/summary.  A
    # client may have been backgrounded at zero, so completion cannot rely on
    # the browser sending the final action.
    rows = con.execute(f"SELECT * FROM {session} WHERE timer_kind=? AND status='running'", (kind,)).fetchall()
    for row in rows:
        if row["planned_seconds"] and _elapsed(row, now) >= row["planned_seconds"]:
            con.execute(f"""UPDATE {session} SET status='completed',elapsed_seconds=planned_seconds,
                ended_at=?,last_resumed_at=NULL,updated_at=datetime('now','localtime') WHERE id=? AND status='running'""", (_stamp(now), row["id"]))


def time_state(kind: str, *, history_limit: int = 8) -> dict:
    if kind not in KINDS:
        raise ValueError("计时类型必须是 pomodoro 或 stopwatch")
    now = _now()
    con = connect()
    try:
        # Refresh also updates resource bindings and expires running timers.
        # Reserve the writer before reading: another startup request must not
        # invalidate the WAL snapshot before our first registry write.
        con.execute("BEGIN IMMEDIATE")
        resources = ensure_plugin_resources(con, "study." + kind)
        session = quote(resources["session"])
        _finish_expired(con, kind, now)
        projection = f"SELECT s.*,NULL project_name,NULL project_color FROM {session} s"
        if kind == "pomodoro":
            projection = f"SELECT s.*,p.name project_name,p.color project_color FROM {session} s LEFT JOIN {quote(resources['project'])} p ON p.id=s.project_id"
        current = con.execute(projection + " WHERE timer_kind=? AND s.status IN ('running','paused') ORDER BY started_at DESC LIMIT 1", (kind,)).fetchone()
        history = [] if kind == "stopwatch" else con.execute(projection + " WHERE timer_kind=? AND s.status IN ('completed','abandoned') ORDER BY ended_at DESC LIMIT ?", (kind, max(1, min(history_limit, 50)))).fetchall()
        laps = []
        if kind == "stopwatch" and current:
            laps = [dict(row) for row in con.execute(f"SELECT lap_number,split_seconds,total_seconds,recorded_at FROM {quote(resources['lap'])} WHERE session_id=? ORDER BY lap_number DESC", (current["id"],))]
        latest_planned = None if kind == "stopwatch" else con.execute(f"SELECT planned_seconds FROM {session} WHERE timer_kind='pomodoro' AND planned_seconds IS NOT NULL ORDER BY started_at DESC LIMIT 1").fetchone()
        result = {"schema": "study.time/v5", "server_now": _stamp(now), "current": _serialize(current, now) if current else None, "history": [] if kind == "stopwatch" else [_serialize(row, now) for row in history], "laps": laps, "projects": [] if kind == "stopwatch" else _projects(con), "preferences": None if kind == "stopwatch" else {"planned_seconds": int(latest_planned["planned_seconds"]) if latest_planned else 1500}, "summary": None if kind == "stopwatch" else _summary(con, kind, now)}
        con.commit()
        return result
    finally:
        con.close()


def time_action(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("请求必须是对象")
    kind = str(payload.get("kind") or "")
    action = str(payload.get("action") or "")
    if kind == "stopwatch":
        return stopwatch_action(action)
    if kind not in KINDS or action not in ACTIONS:
        raise ValueError("计时类型或操作无效")
    now = _now()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        resources = ensure_plugin_resources(con, "study." + kind)
        session, project = quote(resources["session"]), quote(resources["project"])
        _finish_expired(con, kind, now)
        current = con.execute(f"SELECT * FROM {session} WHERE timer_kind=? AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1", (kind,)).fetchone()
        if action == "update":
            session_id = str(payload.get("id") or "").strip()
            task = str(payload.get("task_text") or "").strip()
            note = str(payload.get("note_text") or "").strip()
            project_id = str(payload.get("project_id") or "").strip() or None
            if not session_id or not task or len(task) > 500 or len(note) > 4000:
                raise ValueError("事宜必填且不超过 500 字，备注不超过 4000 字")
            if project_id and not con.execute(f"SELECT 1 FROM {project} WHERE id=?", (project_id,)).fetchone():
                raise ValueError("所选项目不存在")
            if con.execute(f"UPDATE {session} SET task_text=?,project_id=?,note_text=?,updated_at=datetime('now','localtime') WHERE id=? AND timer_kind='pomodoro' AND status IN ('completed','abandoned')", (task, project_id, note, session_id)).rowcount != 1:
                raise ValueError("记录不存在或仍在运行")
        elif action == "start":
            if current:
                raise ValueError("已有进行中的计时，请先完成或放弃")
            task = str(payload.get("task_text") or "").strip()
            if not task:
                task = f"番茄钟 · {now:%m-%d %H:%M}"
            if len(task) > 500:
                raise ValueError("所做事宜不超过 500 字")
            planned = None
            if kind == "pomodoro":
                planned = int(payload.get("planned_seconds") or 1500)
                if not 60 <= planned <= 43200:
                    raise ValueError("番茄钟时长必须在 1 到 720 分钟之间")
            project_id = str(payload.get("project_id") or "").strip() or None
            if project_id and not con.execute(f"SELECT 1 FROM {project} WHERE id=? AND status='active'", (project_id,)).fetchone():
                raise ValueError("所选项目不存在或已归档")
            session_id = "time_" + uuid.uuid4().hex
            stamp = _stamp(now)
            con.execute(f"INSERT INTO {session}(id,timer_kind,task_text,project_id,status,planned_seconds,started_at,last_resumed_at) VALUES (?,?,?,?,?,?,?,?)", (session_id, kind, task, project_id, "running", planned, stamp, stamp))
        else:
            if not current:
                # 倒计时归零时前端会发 complete，但本请求里 _finish_expired 可能已先结账；
                # 若再报错并 rollback，会把刚完成的会话打回 running，页面留下红字且不刷新。
                if action == "complete":
                    con.commit()
                    return time_state(kind)
                raise ValueError("没有进行中的计时")
            elapsed = _elapsed(current, now)
            if action == "pause":
                if current["status"] != "running":
                    raise ValueError("当前计时未运行")
                con.execute(f"UPDATE {session} SET status='paused',elapsed_seconds=?,last_resumed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?", (elapsed, current["id"]))
            elif action == "resume":
                if current["status"] != "paused":
                    raise ValueError("当前计时未暂停")
                con.execute(f"UPDATE {session} SET status='running',last_resumed_at=?,updated_at=datetime('now','localtime') WHERE id=?", (_stamp(now), current["id"]))
            else:
                status = "abandoned" if action == "abandon" else "completed"
                planned = current["planned_seconds"]
                if kind == "pomodoro" and action == "complete" and planned:
                    elapsed = min(elapsed, int(planned))
                con.execute(f"UPDATE {session} SET status=?,elapsed_seconds=?,ended_at=?,last_resumed_at=NULL,abandoned=?,updated_at=datetime('now','localtime') WHERE id=?", (status, elapsed, _stamp(now), int(action == "abandon"), current["id"]))
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return time_state(kind)


def stopwatch_action(action: str) -> dict:
    if action not in STOPWATCH_ACTIONS:
        raise ValueError("秒表操作无效")
    now = _now()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        resources = ensure_plugin_resources(con, "study.stopwatch")
        session, lap = quote(resources["session"]), quote(resources["lap"])
        current = con.execute(f"SELECT * FROM {session} WHERE timer_kind='stopwatch' AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1").fetchone()
        if action == "start":
            if current:
                raise ValueError("秒表已经开始")
            session_id = "time_" + uuid.uuid4().hex
            stamp = _stamp(now)
            con.execute(f"INSERT INTO {session}(id,timer_kind,task_text,status,started_at,last_resumed_at) VALUES (?,?,?,?,?,?)", (session_id, "stopwatch", "秒表", "running", stamp, stamp))
        elif not current:
            if action == "reset":
                from plugin_units import end_leases

                end_leases(con, resources["unit_id"])
                con.commit()
                return time_state("stopwatch")
            raise ValueError("秒表尚未开始")
        elif action == "pause":
            if current["status"] != "running":
                raise ValueError("秒表当前未运行")
            con.execute(f"UPDATE {session} SET status='paused',elapsed_seconds=?,last_resumed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?", (_elapsed(current, now), current["id"]))
        elif action == "resume":
            if current["status"] != "paused":
                raise ValueError("秒表当前未暂停")
            con.execute(f"UPDATE {session} SET status='running',last_resumed_at=?,updated_at=datetime('now','localtime') WHERE id=?", (_stamp(now), current["id"]))
        elif action == "lap":
            if current["status"] != "running":
                raise ValueError("秒表运行时才能计次")
            total = _elapsed(current, now)
            previous = con.execute(f"SELECT lap_number,total_seconds FROM {lap} WHERE session_id=? ORDER BY lap_number DESC LIMIT 1", (current["id"],)).fetchone()
            number = int(previous["lap_number"] if previous else 0) + 1
            split = max(0, total - int(previous["total_seconds"] if previous else 0))
            con.execute(f"INSERT INTO {lap}(id,session_id,lap_number,split_seconds,total_seconds,recorded_at) VALUES (?,?,?,?,?,?)", ("lap_" + uuid.uuid4().hex, current["id"], number, split, total, _stamp(now)))
        elif action == "reset":
            from plugin_units import end_leases

            con.execute(f"DELETE FROM {session} WHERE id=?", (current["id"],))
            end_leases(con, resources["unit_id"])
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return time_state("stopwatch")


def project_action(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("action") not in PROJECT_ACTIONS:
        raise ValueError("项目操作无效")
    action = payload["action"]
    project_id = str(payload.get("id") or "").strip()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        project = quote(ensure_plugin_resources(con, "study.pomodoro")["project"])
        if action == "save":
            name = str(payload.get("name") or "").strip()
            color = str(payload.get("color") or "#4f7cac").strip()
            if not name or len(name) > 100:
                raise ValueError("项目名称必填且不超过 100 字")
            if project_id:
                if con.execute(f"UPDATE {project} SET name=?,color=?,updated_at=datetime('now','localtime') WHERE id=?", (name, color, project_id)).rowcount != 1:
                    raise ValueError("项目不存在")
            else:
                project_id = "project_" + uuid.uuid4().hex
                con.execute(f"INSERT INTO {project}(id,name,color) VALUES (?,?,?)", (project_id, name, color))
        else:
            status = "archived" if action == "archive" else "active"
            if not project_id or con.execute(f"UPDATE {project} SET status=?,updated_at=datetime('now','localtime') WHERE id=?", (status, project_id)).rowcount != 1:
                raise ValueError("项目不存在")
        con.commit()
        return {"schema": "study.time-projects/v1", "projects": _projects(con)}
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
