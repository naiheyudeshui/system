"""Persistent Pomodoro and stopwatch sessions for upper-bar plugins."""

from __future__ import annotations

import uuid
from datetime import datetime

from db import connect

KINDS = {"pomodoro", "stopwatch"}
ACTIONS = {"start", "pause", "resume", "complete", "abandon"}
PROJECT_ACTIONS = {"save", "archive", "restore"}


def _now() -> datetime:
    return datetime.now().astimezone()


def _stamp(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


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
    return [dict(row) for row in con.execute("SELECT * FROM study_time_project ORDER BY status,name COLLATE NOCASE")]


def _summary(con, kind: str) -> dict:
    totals = con.execute("""SELECT COALESCE(SUM(elapsed_seconds),0) seconds,
        SUM(status='completed') completed, SUM(status='abandoned') abandoned
        FROM study_time_session WHERE timer_kind=? AND date(started_at)=date('now','localtime')""", (kind,)).fetchone()
    days = [dict(row) for row in con.execute("""WITH RECURSIVE dates(day) AS (
        SELECT date('now','localtime','-6 days') UNION ALL SELECT date(day,'+1 day') FROM dates WHERE day<date('now','localtime'))
        SELECT dates.day,COALESCE(SUM(s.elapsed_seconds),0) seconds FROM dates
        LEFT JOIN study_time_session s ON date(s.started_at)=dates.day AND s.timer_kind=? AND s.status IN ('completed','abandoned')
        GROUP BY dates.day ORDER BY dates.day""", (kind,))]
    projects = [dict(row) for row in con.execute("""SELECT p.id,p.name,p.color,COALESCE(SUM(s.elapsed_seconds),0) seconds
        FROM study_time_project p LEFT JOIN study_time_session s ON s.project_id=p.id AND s.timer_kind=? AND s.status IN ('completed','abandoned')
        GROUP BY p.id,p.name,p.color HAVING seconds>0 ORDER BY seconds DESC,p.name LIMIT 12""", (kind,))]
    return {"today": dict(totals), "days": days, "projects": projects}


def _finish_expired(con, kind: str, now: datetime) -> None:
    row = con.execute("SELECT * FROM study_time_session WHERE timer_kind=? AND status='running'", (kind,)).fetchone()
    if row and kind == "pomodoro" and row["planned_seconds"] and _elapsed(row, now) >= row["planned_seconds"]:
        con.execute("""UPDATE study_time_session SET status='completed',elapsed_seconds=planned_seconds,
            ended_at=?,last_resumed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?""", (_stamp(now), row["id"]))


def time_state(kind: str, *, history_limit: int = 8) -> dict:
    if kind not in KINDS:
        raise ValueError("计时类型必须是 pomodoro 或 stopwatch")
    now = _now()
    con = connect()
    try:
        _finish_expired(con, kind, now)
        con.commit()
        current = con.execute("SELECT s.*,p.name project_name,p.color project_color FROM study_time_session s LEFT JOIN study_time_project p ON p.id=s.project_id WHERE timer_kind=? AND s.status IN ('running','paused') ORDER BY started_at DESC LIMIT 1", (kind,)).fetchone()
        history = con.execute("SELECT s.*,p.name project_name,p.color project_color FROM study_time_session s LEFT JOIN study_time_project p ON p.id=s.project_id WHERE timer_kind=? AND s.status IN ('completed','abandoned') ORDER BY ended_at DESC LIMIT ?", (kind, max(1, min(history_limit, 50)))).fetchall()
        return {"schema": "study.time/v2", "server_now": _stamp(now), "current": _serialize(current, now) if current else None, "history": [_serialize(row, now) for row in history], "projects": _projects(con), "summary": _summary(con, kind)}
    finally:
        con.close()


def time_action(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("请求必须是对象")
    kind = str(payload.get("kind") or "")
    action = str(payload.get("action") or "")
    if kind not in KINDS or action not in ACTIONS:
        raise ValueError("计时类型或操作无效")
    now = _now()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        _finish_expired(con, kind, now)
        current = con.execute("SELECT * FROM study_time_session WHERE timer_kind=? AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1", (kind,)).fetchone()
        if action == "start":
            if current:
                raise ValueError("已有进行中的计时，请先完成或放弃")
            task = str(payload.get("task_text") or "").strip()
            if not task or len(task) > 500:
                raise ValueError("所做事宜必填且不超过 500 字")
            planned = None
            if kind == "pomodoro":
                planned = int(payload.get("planned_seconds") or 1500)
                if not 60 <= planned <= 43200:
                    raise ValueError("番茄钟时长必须在 1 到 720 分钟之间")
            project_id = str(payload.get("project_id") or "").strip() or None
            if project_id and not con.execute("SELECT 1 FROM study_time_project WHERE id=? AND status='active'", (project_id,)).fetchone():
                raise ValueError("所选项目不存在或已归档")
            session_id = "time_" + uuid.uuid4().hex
            stamp = _stamp(now)
            con.execute("INSERT INTO study_time_session(id,timer_kind,task_text,project_id,status,planned_seconds,started_at,last_resumed_at) VALUES (?,?,?,?,?,?,?,?)", (session_id, kind, task, project_id, "running", planned, stamp, stamp))
        else:
            if not current:
                raise ValueError("没有进行中的计时")
            elapsed = _elapsed(current, now)
            if action == "pause":
                if current["status"] != "running":
                    raise ValueError("当前计时未运行")
                con.execute("UPDATE study_time_session SET status='paused',elapsed_seconds=?,last_resumed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?", (elapsed, current["id"]))
            elif action == "resume":
                if current["status"] != "paused":
                    raise ValueError("当前计时未暂停")
                con.execute("UPDATE study_time_session SET status='running',last_resumed_at=?,updated_at=datetime('now','localtime') WHERE id=?", (_stamp(now), current["id"]))
            else:
                status = "abandoned" if action == "abandon" else "completed"
                planned = current["planned_seconds"]
                if kind == "pomodoro" and action == "complete" and planned:
                    elapsed = min(elapsed, int(planned))
                con.execute("UPDATE study_time_session SET status=?,elapsed_seconds=?,ended_at=?,last_resumed_at=NULL,abandoned=?,updated_at=datetime('now','localtime') WHERE id=?", (status, elapsed, _stamp(now), int(action == "abandon"), current["id"]))
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    return time_state(kind)


def project_action(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("action") not in PROJECT_ACTIONS:
        raise ValueError("项目操作无效")
    action = payload["action"]
    project_id = str(payload.get("id") or "").strip()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        if action == "save":
            name = str(payload.get("name") or "").strip()
            color = str(payload.get("color") or "#4f7cac").strip()
            if not name or len(name) > 100:
                raise ValueError("项目名称必填且不超过 100 字")
            if project_id:
                if con.execute("UPDATE study_time_project SET name=?,color=?,updated_at=datetime('now','localtime') WHERE id=?", (name, color, project_id)).rowcount != 1:
                    raise ValueError("项目不存在")
            else:
                project_id = "project_" + uuid.uuid4().hex
                con.execute("INSERT INTO study_time_project(id,name,color) VALUES (?,?,?)", (project_id, name, color))
        else:
            status = "archived" if action == "archive" else "active"
            if not project_id or con.execute("UPDATE study_time_project SET status=?,updated_at=datetime('now','localtime') WHERE id=?", (status, project_id)).rowcount != 1:
                raise ValueError("项目不存在")
        con.commit()
        return {"schema": "study.time-projects/v1", "projects": _projects(con)}
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
