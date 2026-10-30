"""Installation-scoped timer storage and non-destructive legacy cutover.

The host calls ensure_plugin_resources in its installation transaction.  Timer
service entry points also use it to adapt previously installed workspaces.  No
table is provisioned merely by bootstrapping a Study database.
"""

from __future__ import annotations

import hashlib
import sqlite3
import sys
from pathlib import Path

SHARED_PYTHON = Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"
if str(SHARED_PYTHON) not in sys.path:
    sys.path.append(str(SHARED_PYTHON))

PLUGINS = {"study.pomodoro": "pomodoro", "study.stopwatch": "stopwatch"}
SESSION_COLUMNS = ("id", "timer_kind", "task_text", "note_text", "project_id", "status",
                   "planned_seconds", "elapsed_seconds", "started_at", "last_resumed_at",
                   "ended_at", "abandoned", "created_at", "updated_at")


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _exists(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _name(plugin_id, workspace_id, role):
    suffix = hashlib.sha256((workspace_id + ":" + plugin_id + ":" + role).encode()).hexdigest()[:12]
    return "wbp_" + plugin_id.replace(".", "_") + "_" + role + "_" + suffix


def _create(con, kind, names):
    session = quote(names["session"])
    if kind == "pomodoro":
        project = quote(names["project"])
        con.execute(f"""CREATE TABLE {project} (
            id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(name)) BETWEEN 1 AND 100),
            color TEXT NOT NULL DEFAULT '#4f7cac' CHECK(length(color) BETWEEN 4 AND 32),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
        con.execute(f"CREATE UNIQUE INDEX {quote(names['project'] + '_name')} ON {project}(name)")
        project_column = f"REFERENCES {project}(id) ON UPDATE CASCADE ON DELETE SET NULL"
        status_check = "'running','paused','completed','abandoned'"
    else:
        project_column = "CHECK(project_id IS NULL)"
        status_check = "'running','paused'"
    con.execute(f"""CREATE TABLE {session} (
        id TEXT PRIMARY KEY,
        timer_kind TEXT NOT NULL DEFAULT '{kind}' CHECK(timer_kind='{kind}'),
        task_text TEXT NOT NULL CHECK(length(trim(task_text)) BETWEEN 1 AND 500),
        note_text TEXT NOT NULL DEFAULT '' CHECK(length(note_text)<=4000),
        project_id TEXT {project_column},
        status TEXT NOT NULL CHECK(status IN ({status_check})),
        planned_seconds INTEGER CHECK(planned_seconds IS NULL OR planned_seconds BETWEEN 60 AND 43200),
        elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_seconds>=0),
        started_at TEXT NOT NULL, last_resumed_at TEXT, ended_at TEXT,
        abandoned INTEGER NOT NULL DEFAULT 0 CHECK(abandoned IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        {", CHECK(ended_at IS NULL AND abandoned=0 AND planned_seconds IS NULL)" if kind == 'stopwatch' else ''})""")
    con.execute(f"CREATE UNIQUE INDEX {quote(names['session'] + '_active')} ON {session}(timer_kind) WHERE status IN ('running','paused')")
    if kind == "pomodoro":
        con.execute(f"CREATE INDEX {quote(names['session'] + '_project')} ON {session}(project_id,started_at DESC)")
    else:
        con.execute(f"""CREATE TABLE {quote(names['lap'])} (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES {session}(id) ON DELETE CASCADE,
            lap_number INTEGER NOT NULL CHECK(lap_number>0), split_seconds INTEGER NOT NULL CHECK(split_seconds>=0),
            total_seconds INTEGER NOT NULL CHECK(total_seconds>=0), recorded_at TEXT NOT NULL,
            UNIQUE(session_id,lap_number))""")


def _fence(con, table, kind=None):
    """Old servers fail explicitly instead of silently writing the old store."""
    if not _exists(con, table):
        return
    for operation in ("INSERT", "UPDATE", "DELETE"):
        refs = ["NEW"] if operation == "INSERT" else ["OLD"] if operation == "DELETE" else ["OLD", "NEW"]
        condition = " WHEN " + " OR ".join(f"{ref}.timer_kind='{kind}'" for ref in refs) if kind else ""
        trigger = quote("wb_timer_cutover_" + table + "_" + (kind or "all") + "_" + operation.lower())
        con.execute(f"""CREATE TRIGGER IF NOT EXISTS {trigger} BEFORE {operation} ON {quote(table)}{condition}
            BEGIN SELECT RAISE(ABORT,'Timer storage migrated; restart the server before writing'); END""")


def _migrate(con, kind, names, workspace_id):
    result = {"legacy_rows": 0, "copied_rows": 0}
    if workspace_id != "default":
        return result
    if kind == "pomodoro" and _exists(con, "study_time_project"):
        columns = "id,name,color,status,created_at,updated_at"
        con.execute(f"INSERT INTO {quote(names['project'])}({columns}) SELECT {columns} FROM study_time_project")
    if _exists(con, "study_time_session"):
        result["legacy_rows"] = con.execute("SELECT count(*) FROM study_time_session WHERE timer_kind=?", (kind,)).fetchone()[0]
        active = con.execute("SELECT count(*) FROM study_time_session WHERE timer_kind=? AND status IN ('running','paused')", (kind,)).fetchone()[0]
        if active > 1:
            raise ValueError(f"{kind} 有多个旧活动计时，请先核对，迁移未执行")
        columns = {row[1] for row in con.execute("PRAGMA table_info(study_time_session)")}
        expressions = []
        for name in SESSION_COLUMNS:
            if kind == "stopwatch" and name in ("project_id", "planned_seconds", "ended_at"):
                expressions.append("NULL")
            elif kind == "stopwatch" and name == "abandoned":
                expressions.append("0")
            elif name in columns:
                expressions.append(quote(name))
            else:
                expressions.append("''" if name == "note_text" else "NULL")
        condition = "timer_kind=?" + (" AND status IN ('running','paused')" if kind == "stopwatch" else "")
        copied = con.execute(f"INSERT INTO {quote(names['session'])}({','.join(map(quote, SESSION_COLUMNS))}) SELECT {','.join(expressions)} FROM study_time_session WHERE {condition}", (kind,))
        result["copied_rows"] = copied.rowcount
        if kind == "stopwatch" and _exists(con, "study_stopwatch_lap"):
            con.execute(f"""INSERT INTO {quote(names['lap'])}
                SELECT l.* FROM study_stopwatch_lap l JOIN {quote(names['session'])} s ON s.id=l.session_id""")
    _fence(con, "study_time_session", kind)
    _fence(con, "study_time_project" if kind == "pomodoro" else "study_stopwatch_lap")
    return result


def _register(con, plugin_id, workspace_id, names):
    from plugin_units import bind_objects, ensure_installation, ensure_unit, register_resource

    ensure_installation(con, plugin_id, workspace_id=workspace_id)
    kind = PLUGINS[plugin_id]
    unit = ensure_unit(con, plugin_id, "timer-default", kind + ".default", "番茄钟" if kind == "pomodoro" else "秒表", workspace_id=workspace_id)
    for name in names.values():
        register_resource(con, name, owner_plugin_id=plugin_id)
    bind_objects(con, unit["unit_id"], "timer-storage", list(names.values()), access="write", contract="study." + kind + "/v1")
    for name in ("study_time_session", "study_time_project", "study_stopwatch_lap"):
        if _exists(con, name):
            register_resource(con, name, protected=True)
    return unit["unit_id"]


def ensure_plugin_resources(con: sqlite3.Connection, plugin_id: str, workspace_id: str = "default") -> dict:
    if plugin_id not in PLUGINS:
        raise ValueError("Unknown timer plugin")
    kind = PLUGINS[plugin_id]
    names = {"session": _name(plugin_id, workspace_id, "pomodoro_session" if kind == "pomodoro" else "stopwatch_state")}
    role = "project" if kind == "pomodoro" else "lap"
    names[role] = _name(plugin_id, workspace_id, "pomodoro_project" if kind == "pomodoro" else "stopwatch_lap")
    con.execute("SAVEPOINT timer_installation_resources")
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS workbench_timer_resource (
            plugin_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            legacy_rows INTEGER NOT NULL, copied_rows INTEGER NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(plugin_id,workspace_id))""")
        record = con.execute("SELECT legacy_rows,copied_rows FROM workbench_timer_resource WHERE plugin_id=? AND workspace_id=?", (plugin_id, workspace_id)).fetchone()
        if record is None:
            _create(con, kind, names)
            migration = _migrate(con, kind, names, workspace_id)
            con.execute("INSERT INTO workbench_timer_resource(plugin_id,workspace_id,legacy_rows,copied_rows) VALUES (?,?,?,?)", (plugin_id, workspace_id, migration["legacy_rows"], migration["copied_rows"]))
        else:
            migration = {"legacy_rows": record[0], "copied_rows": record[1]}
            if any(not _exists(con, name) for name in names.values()):
                raise ValueError("Timer storage is missing; restore its backup before continuing")
        unit_id = _register(con, plugin_id, workspace_id, names)
        con.execute("RELEASE SAVEPOINT timer_installation_resources")
        return {"plugin_id": plugin_id, "workspace_id": workspace_id, "unit_id": unit_id, **names, "migration": migration}
    except Exception:
        con.execute("ROLLBACK TO SAVEPOINT timer_installation_resources")
        con.execute("RELEASE SAVEPOINT timer_installation_resources")
        raise
