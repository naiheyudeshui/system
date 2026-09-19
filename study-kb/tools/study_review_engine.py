"""Configurable view-based collections with atomic scheduling writes."""

from __future__ import annotations

import json
import random
import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Any

from study_kb import grade_card, open_db


def identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def columns(con: sqlite3.Connection, name: str, kind: str) -> list[dict]:
    if not isinstance(name, str) or not con.execute(
        "SELECT 1 FROM sqlite_master WHERE name=? AND type=?", (name, kind)
    ).fetchone():
        raise ValueError(f"Unknown {kind}: {name}")
    return [dict(row) for row in con.execute(f"PRAGMA table_info({identifier(name)})")]


def writable_targets(con: sqlite3.Connection) -> list[dict]:
    targets = []
    for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        name = row["name"]
        if name.lower().startswith(("sqlite_", "study_", "workbench_", "studio_")) or name.lower() in {"app_setting", "schema_doc"}:
            continue
        info = columns(con, name, "table")
        primary = [col["name"] for col in info if col["pk"]]
        keys = primary if len(primary) == 1 else []
        for index in con.execute(f"PRAGMA index_list({identifier(name)})"):
            if index["unique"] and not index["partial"]:
                parts = list(con.execute(f"PRAGMA index_info({identifier(index['name'])})"))
                if len(parts) == 1 and parts[0]["name"]:
                    keys.append(parts[0]["name"])
        times = [col["name"] for col in info if any(
            token in col["type"].upper() for token in ("TEXT", "CHAR", "DATE", "TIME")
        ) and col["name"] not in keys]
        if keys and times:
            targets.append({"table": name, "keys": sorted(set(keys)), "time_columns": times})
    return targets


def review_catalog() -> dict:
    con = open_db()
    try:
        views = []
        for row in con.execute("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name"):
            try:
                fields = [col["name"] for col in columns(con, row["name"], "view")]
                views.append({"name": row["name"], "columns": fields})
            except sqlite3.Error:
                continue
        return {"views": views, "targets": writable_targets(con), "nodes": [dict(row) for row in con.execute(
            "SELECT id, parent_id, title FROM study_node ORDER BY sort_order, title, id"
        )]}
    finally:
        con.close()


def validate_config(con: sqlite3.Connection, config: dict) -> dict:
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    config = json.loads(json.dumps(config))
    fields = {col["name"] for col in columns(con, config.get("view"), "view")}
    mapping = config.get("mapping")
    if not isinstance(mapping, dict):
        raise ValueError("Field mapping is required")
    for role in ("key", "front", "back"):
        if mapping.get(role) not in fields:
            raise ValueError(f"Choose a valid {role} field")
    for role in ("node", "hint"):
        if mapping.get(role) and mapping[role] not in fields:
            raise ValueError(f"Unknown {role} field")
    if config.get("mode") not in ("all", "due"):
        raise ValueError("mode must be all or due")
    root = config.get("root_id")
    if root and (not mapping.get("node") or not con.execute("SELECT 1 FROM study_node WHERE id=?", (root,)).fetchone()):
        raise ValueError("Node selection requires a valid node field and root")
    limit = config.get("limit", 100)
    if type(limit) is not int or not 1 <= limit <= 5000:
        raise ValueError("Collection size must be 1–5000")
    config["limit"] = limit
    filters = config.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 20:
        raise ValueError("At most 20 filters are supported")
    for rule in filters:
        if not isinstance(rule, dict) or rule.get("field") not in fields or rule.get("op") not in (
            "eq", "ne", "contains", "lt", "lte", "gt", "gte", "empty", "not_empty"
        ):
            raise ValueError("Invalid filter")
        if not isinstance(rule.get("value", ""), (str, int, float, type(None))):
            raise ValueError("Invalid filter value")
    order = config.get("order", [])
    if not isinstance(order, list) or len(order) > 5:
        raise ValueError("At most 5 sort fields are supported")
    for rule in order:
        if not isinstance(rule, dict) or rule.get("field") not in fields or rule.get("direction") not in ("asc", "desc"):
            raise ValueError("Invalid sort rule")
    scheduler = config.get("scheduler", {"kind": "fsrs"})
    if not isinstance(scheduler, dict):
        raise ValueError("Invalid scheduler")
    if scheduler.get("kind") == "fsrs":
        config["scheduler"] = {"kind": "fsrs", "table": "study_card_fsrs", "key": "card_id", "due": "due_at"}
    elif scheduler.get("kind") == "interval":
        target = next((item for item in writable_targets(con) if item["table"] == scheduler.get("table")), None)
        if not target or scheduler.get("key") not in target["keys"] or scheduler.get("due") not in target["time_columns"]:
            raise ValueError("Choose a writable custom table, unique key and time field")
        days = scheduler.get("days")
        if not isinstance(days, list) or len(days) != 4 or any(type(day) not in (int, float) or not 0 < day <= 36500 for day in days):
            raise ValueError("Four positive rating intervals (days) are required")
        config["scheduler"] = scheduler
    else:
        raise ValueError("Unknown scheduler")
    return config


def collection(con: sqlite3.Connection, config: dict) -> tuple[list[dict], int]:
    mapping = config["mapping"]
    scheduler = config["scheduler"]
    source_key = f'v.{identifier(mapping["key"])}'
    target_key = f't.{identifier(scheduler["key"])}'
    conditions = [f"{source_key} IS NOT NULL"]
    params: list[Any] = []
    if scheduler["kind"] == "fsrs":
        conditions.append(f"EXISTS (SELECT 1 FROM study_card c WHERE c.id={source_key} AND c.status='active')")
    if config["mode"] == "due":
        conditions.append(f"datetime(t.{identifier(scheduler['due'])}) <= datetime('now', 'localtime')")
    if config.get("root_id"):
        conditions.append(f'''v.{identifier(mapping['node'])} IN (
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM study_node WHERE id=?
                UNION SELECT n.id FROM study_node n JOIN subtree s ON n.parent_id=s.id
            ) SELECT id FROM subtree)''')
        params.append(config["root_id"])
    operators = {"eq": "=", "ne": "!=", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
    for rule in config.get("filters", []):
        field = f'v.{identifier(rule["field"])}'
        op = rule["op"]
        if op in ("empty", "not_empty"):
            conditions.append(f"({field} IS NULL OR {field} = '')" if op == "empty" else f"({field} IS NOT NULL AND {field} != '')")
        elif op == "contains":
            conditions.append(f"instr(CAST({field} AS TEXT), ?) > 0")
            params.append(str(rule.get("value", "")))
        else:
            conditions.append(f"{field} {operators[op]} ?")
            params.append(rule.get("value", ""))
    sort = [f'v.{identifier(rule["field"])} {rule["direction"].upper()}' for rule in config.get("order", [])]
    sort.append(source_key)
    roles = ["key", "front", "back", "hint"]
    select = [f'v.{identifier(mapping[role])} AS {identifier(role)}' if mapping.get(role) else f"NULL AS {identifier(role)}" for role in roles]
    select[0] = f"{target_key} AS key"
    if config["view"] in {"v_study_node_cards", "v_study_due_cards"} and mapping["back"] == "back":
        select[2] = "COALESCE(NULLIF(v.back, ''), v.answer_md) AS back"
    select.append(f't.{identifier(scheduler["due"])} AS due_at')
    query = f'''SELECT {', '.join(select)} FROM {identifier(config['view'])} v
        JOIN {identifier(scheduler['table'])} t ON {target_key}={source_key}
        WHERE {' AND '.join(conditions)} ORDER BY {', '.join(sort)}'''
    items = []
    seen = set()
    for row in con.execute(query, params):
        item = dict(row)
        key = item["key"]
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
        if len(items) > 50000:
            raise ValueError("Too many matches; narrow the filters (maximum 50000)")
    total = len(items)
    if config.get("random"):
        random.SystemRandom().shuffle(items)
    return items[:config["limit"]], total


def prepare_review(config: dict, *, preview: bool = False) -> dict:
    con = open_db()
    try:
        con.execute("BEGIN IMMEDIATE" if not preview else "BEGIN")
        config = validate_config(con, config)
        items, total = collection(con, config)
        if preview:
            return {"matched": total, "selected": len(items), "sample": items[:5]}
        session_id = uuid.uuid4().hex
        con.execute("INSERT INTO study_review_session (id, config_json) VALUES (?, ?)", (session_id, json.dumps(config)))
        con.executemany("INSERT INTO study_review_session_item (session_id, position, item_json) VALUES (?, ?, ?)",
                        [(session_id, position, json.dumps(item)) for position, item in enumerate(items)])
        con.commit()
        return session_state(con, session_id)
    finally:
        con.close()


def session_state(con: sqlite3.Connection, session_id: str) -> dict:
    session = con.execute("SELECT config_json FROM study_review_session WHERE id=?", (session_id,)).fetchone()
    if not session:
        raise ValueError("Unknown review session")
    counts = con.execute("SELECT COUNT(*) AS total, COUNT(result_json) AS completed FROM study_review_session_item WHERE session_id=?", (session_id,)).fetchone()
    row = con.execute("SELECT position, item_json FROM study_review_session_item WHERE session_id=? AND result_json IS NULL ORDER BY position LIMIT 1", (session_id,)).fetchone()
    return {"session_id": session_id, "config": json.loads(session["config_json"]), **dict(counts),
            "position": row["position"] if row else None, "card": json.loads(row["item_json"]) if row else None}


def get_review_session(session_id: str) -> dict:
    con = open_db()
    try:
        return session_state(con, session_id)
    finally:
        con.close()


def grade_session(*, session_id: str, position: int, rating: int, elapsed_ms: int | None = None) -> dict:
    if type(rating) is not int or rating not in (1, 2, 3, 4) or type(position) is not int or position < 0:
        raise ValueError("Valid position and rating (1–4) are required")
    if elapsed_ms is not None and (type(elapsed_ms) is not int or elapsed_ms < 0):
        raise ValueError("elapsed_ms must be a nonnegative integer")
    con = open_db()
    try:
        con.execute("BEGIN IMMEDIATE")
        state = session_state(con, session_id)
        row = con.execute("SELECT item_json, result_json FROM study_review_session_item WHERE session_id=? AND position=?", (session_id, position)).fetchone()
        if not row:
            raise ValueError("Unknown session item")
        if row["result_json"]:
            return {"graded": json.loads(row["result_json"]), "next": state, "replayed": True}
        if state["position"] != position:
            raise ValueError("Only the current item may be graded")
        item = json.loads(row["item_json"])
        scheduler = state["config"]["scheduler"]
        if scheduler["kind"] == "fsrs":
            active = con.execute("SELECT 1 FROM study_card WHERE id=? AND status='active'", (item["key"],)).fetchone()
            if not active:
                raise ValueError("Card was removed or suspended; start a new collection")
            result = grade_card(con, card_id=item["key"], rating=rating, elapsed_ms=elapsed_ms)
        else:
            target = next((entry for entry in writable_targets(con) if entry["table"] == scheduler["table"]), None)
            if not target or scheduler["key"] not in target["keys"] or scheduler["due"] not in target["time_columns"]:
                raise ValueError("Scheduling target changed; start a new collection")
            due_at = (datetime.now() + timedelta(days=scheduler["days"][rating - 1])).strftime("%Y-%m-%d %H:%M:%S")
            cursor = con.execute(f'UPDATE {identifier(scheduler["table"])} SET {identifier(scheduler["due"])}=? WHERE {identifier(scheduler["key"])}=?', (due_at, item["key"]))
            if cursor.rowcount != 1:
                raise ValueError("Scheduling target no longer exists")
            result = {"key": item["key"], "due_at": due_at, "rating": rating, "elapsed_ms": elapsed_ms}
        con.execute("UPDATE study_review_session_item SET result_json=? WHERE session_id=? AND position=?", (json.dumps(result), session_id, position))
        next_state = session_state(con, session_id)
        con.commit()
        return {"graded": result, "next": next_state}
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
