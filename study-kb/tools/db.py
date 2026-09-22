"""Standalone SQLite bootstrap for the system study knowledge base."""

from __future__ import annotations

import re
import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VIEWS = ROOT / "schema" / "v_study_kb.sql"
PLATFORM = ROOT / "schema" / "workbench_platform.sql"
SCHEMA_DOC = ROOT / "schema" / "schema_doc_study.sql"
WORKBENCH_DEFAULTS = ROOT / "schema" / "study_workbench_defaults.sql"
DB_PATH = ROOT / "data" / "study.sqlite"
DELETED_MANAGED_VIEWS_KEY = "workbench.deleted_views.v1"

_INITIALIZED_PATHS: set[str] = set()
_INITIALIZATION_LOCK = threading.RLock()


def _normalized_sql(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().rstrip(";")).lower()


def _ensure_view_script(con: sqlite3.Connection, path: Path) -> None:
    script = path.read_text(encoding="utf-8")
    for raw_statement in script.split(";"):
        statement = re.sub(r"(?m)^\s*--.*(?:\n|$)", "", raw_statement).strip()
        if not statement:
            continue
        drop = re.match(r"DROP\s+VIEW\s+IF\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)$", statement, re.IGNORECASE | re.DOTALL)
        if drop:
            name = drop.group(1)
            if not con.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?", (name,)).fetchone():
                continue
            con.execute(f'DROP VIEW "{name.replace(chr(34), chr(34) * 2)}"')
            continue
        create = re.match(r"CREATE\s+VIEW\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(.+)$", statement, re.IGNORECASE | re.DOTALL)
        if not create:
            con.execute(statement)
            continue
        name = create.group(1)
        current = con.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name=?", (name,)).fetchone()
        if current and _normalized_sql(current[0]) == _normalized_sql(statement):
            continue
        con.execute(f'DROP VIEW IF EXISTS "{name.replace(chr(34), chr(34) * 2)}"')
        con.execute(statement)


def _has_column(con: sqlite3.Connection, table: str, column: str) -> bool:
    rows = con.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row[1] == column for row in rows)


def upgrade_knowledge_tree_config(con: sqlite3.Connection) -> None:
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_plugin_config'").fetchone():
        return
    con.execute("""UPDATE workbench_plugin_config
        SET sql = 'SELECT * FROM v_study_knowledge_nodes ORDER BY sort_order,title,node_id',
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = 'study.tree.default.v1' AND plugin_id = 'study.node-tree' AND module_id = 'trees'
          AND deleted = 0 AND revision = 1 AND settings = '{}' AND parameters = '{}'""")


def ensure_schema(con: sqlite3.Connection) -> None:
    if PLATFORM.exists():
        con.executescript(PLATFORM.read_text(encoding="utf-8"))
    con.executescript((ROOT / "schema" / "knowledge_items.sql").read_text(encoding="utf-8"))
    upgrade_knowledge_tree_config(con)
    if VIEWS.exists():
        _ensure_view_script(con, VIEWS)
    if SCHEMA_DOC.exists():
        con.executescript(SCHEMA_DOC.read_text(encoding="utf-8"))
    if WORKBENCH_DEFAULTS.exists():
        con.executescript(WORKBENCH_DEFAULTS.read_text(encoding="utf-8"))


def connect(db_path: Path | None = None, *, migrate: bool = True) -> sqlite3.Connection:
    path = db_path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=8)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 8000")
    con.execute("PRAGMA journal_mode = WAL")
    path_key = str(path.resolve())
    with _INITIALIZATION_LOCK:
        if path_key not in _INITIALIZED_PATHS:
            if migrate:
                ensure_schema(con)
                con.commit()
            _INITIALIZED_PATHS.add(path_key)
    return con


def init_db(db_path: Path | None = None) -> Path:
    path = db_path or DB_PATH
    if path.exists():
        raise FileExistsError(f"database already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        ensure_schema(con)
        con.commit()
    finally:
        con.close()
    return path
