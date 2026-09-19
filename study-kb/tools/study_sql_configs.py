"""Study adapters for optional shared SQL configuration modules."""

from __future__ import annotations

import json
import sys
import uuid
import time
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[2] / "3dStudio" / "tools"))

from plugin_workspace import register_module
from workbench_plugins import configs, query_rows, seed_configs, validate_result
from study_kb import open_db


NODE_FILTER = """(:node_id IS NULL OR node_id IN (
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM study_node WHERE id=:node_id
      UNION SELECT child.id FROM study_node child JOIN subtree ON child.parent_id=subtree.id
    ) SELECT id FROM subtree))"""
DEFAULTS = [
    {"id": "study.review.chapters.v1", "name": "章节卡片", "sql": f"""SELECT card_id, front AS question,
    COALESCE(NULLIF(back,''), answer_md) AS answer, hint, node_id
FROM v_study_node_cards
WHERE {NODE_FILTER}
ORDER BY node_title, card_id""", "parameters": {"node_id": None}, "settings": {"scheduler": {"kind": "fsrs"}, "limit": 5000}},
    {"id": "study.review.due.v1", "name": "今日到期", "sql": f"""SELECT card_id, front AS question,
    COALESCE(NULLIF(back,''), answer_md) AS answer, hint, node_id
FROM v_study_due_cards
WHERE {NODE_FILTER}
ORDER BY due_at, card_id""", "parameters": {"node_id": None}, "settings": {"scheduler": {"kind": "fsrs"}, "limit": 5000}},
]
TREE_DEFAULTS = [{"id": "study.tree.default.v1", "name": "全部章节", "sql": "SELECT * FROM v_study_knowledge_nodes ORDER BY sort_order,title,node_id"}]


def register_study_modules():
    for default in DEFAULTS:
        default["contract_version"] = "review-cards/v1"
    for default in TREE_DEFAULTS:
        default["contract_version"] = "tree-nodes/v1"
    register_module("study.review-table", "reviews", contract="review-cards/v1", label="复习方案", defaults=DEFAULTS)
    register_module("study.node-tree", "trees", contract="tree-nodes/v1", label="章节树方案", defaults=TREE_DEFAULTS)


register_study_modules()


def read_config(con, key):
    seed_configs(con, "study.review-table", "reviews", DEFAULTS)
    item = next((entry for entry in configs(con, "study.review-table", "reviews") if entry["id"] == key), None)
    if not item:
        raise ValueError("复习方案不存在或已删除")
    return item


def sql_tree(key):
    con = open_db()
    try:
        seed_configs(con, "study.node-tree", "trees", TREE_DEFAULTS)
        con.commit()
        saved = next((item for item in configs(con, "study.node-tree", "trees") if item["id"] == key), None)
        if not saved:
            raise ValueError("树方案不存在或已删除")
        from tree_model import tree_result
        result = tree_result(query_rows(con, saved["sql"], saved["parameters"], limit=5000, seconds=5), saved["settings"])
        if saved["sql"] == TREE_DEFAULTS[0]["sql"] and not saved["parameters"] and not saved["settings"]:
            result["editing"] = {"provider": "study-knowledge/v1"}
        return result
    finally:
        con.close()


def sql_review(payload, *, preview=False):
    from study_review_engine import identifier, session_state, validate_config
    con = open_db()
    try:
        saved = read_config(con, payload.get("config_id"))
        con.commit()
        con.execute("BEGIN" if preview else "BEGIN IMMEDIATE")
        parameters = payload.get("parameters", saved["parameters"])
        settings = saved["settings"]
        configuration = validate_config(con, {
            "view": "v_study_node_cards", "mode": "all", "mapping": {"key": "card_id", "front": "front", "back": "back"},
            "limit": settings.get("limit", 5000), "scheduler": settings.get("scheduler", {"kind": "fsrs"}),
        })
        result = validate_result(query_rows(con, saved["sql"], parameters, limit=50000, seconds=5, byte_limit=16*1048576), "review-cards/v1")
        if result["truncated"]:
            raise ValueError("超过 50000 条候选，请在 SQL 中缩小范围")
        scheduler = configuration["scheduler"]
        node_paths = {}
        if "node_id" in result["columns"]:
            nodes = {node["id"]: node for node in con.execute("SELECT id,parent_id,title FROM study_node")}
            for node_id in {row.get("node_id") for row in result["rows"]}:
                path, visited = [], set()
                current = node_id
                while current in nodes and current not in visited:
                    visited.add(current)
                    path.append(nodes[current]["title"])
                    current = nodes[current]["parent_id"]
                node_paths[node_id] = " / ".join(reversed(path))
        deadline = time.monotonic() + 5
        items, rows, seen = [], [], set()
        missing = duplicates = 0
        for row in result["rows"]:
            if time.monotonic() > deadline:
                raise ValueError("调度关联超过时间限制，请缩小 SQL 范围")
            key = row["card_id"]
            target = con.execute(f'SELECT {identifier(scheduler["key"])}, {identifier(scheduler["due"])} FROM {identifier(scheduler["table"])} WHERE {identifier(scheduler["key"])}=?', (key,)).fetchone()
            if not target or (scheduler["kind"] == "fsrs" and not con.execute("SELECT 1 FROM study_card WHERE id=? AND status='active'", (key,)).fetchone()):
                missing += 1
                continue
            key = target[0]
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            preview_row = {**row, "card_id": key, "due_at": target[1]}
            if node_paths and "node_path" not in preview_row:
                preview_row["node_path"] = node_paths.get(row.get("node_id"), "")
            rows.append(preview_row)
            items.append({"key": key, "front": row["question"], "back": row["answer"], "hint": row.get("hint"), "due_at": target[1]})
        import hashlib
        preview_hash = hashlib.sha256(json.dumps({"revision": saved["revision"], "parameters": parameters, "rows": rows}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        matched = len(items)
        selected_keys = payload.get("selected_keys")
        if selected_keys is not None:
            if not isinstance(selected_keys, list) or not selected_keys or any(not isinstance(key, (str, int, float)) or isinstance(key, bool) for key in selected_keys):
                raise ValueError("请选择至少一张预览卡片")
            if payload.get("preview_hash") != preview_hash:
                raise ValueError("方案或候选数据已变化，请重新预览后开始")
            if len(selected_keys) != len(set(selected_keys)) or not set(selected_keys).issubset(seen):
                raise ValueError("选择的卡片不属于当前预览或存在重复")
            selected_set = set(selected_keys)
            items = [item for item in items if item["key"] in selected_set]
        if settings.get("random"):
            import random
            random.SystemRandom().shuffle(items)
        items = items[:configuration["limit"]]
        if preview:
            return {"matched": matched, "selected": len(items), "duplicates": duplicates, "missing_schedule": missing, "sample": items[:5], "rows": rows, "columns": list(dict.fromkeys([*result["columns"], "due_at", *(["node_path"] if node_paths else [])])), "limit": configuration["limit"], "preview_hash": preview_hash}
        configuration.update({"source": "sql", "config_id": saved["id"], "config_revision": saved["revision"], "view": saved["name"], "sql": saved["sql"], "parameters": parameters, "selected_keys": selected_keys, "preview_hash": payload.get("preview_hash")})
        session_id = uuid.uuid4().hex
        con.execute("INSERT INTO study_review_session (id,config_json) VALUES (?,?)", (session_id, json.dumps(configuration)))
        con.executemany("INSERT INTO study_review_session_item (session_id,position,item_json) VALUES (?,?,?)", [(session_id, position, json.dumps(item)) for position, item in enumerate(items)])
        state = session_state(con, session_id)
        con.commit()
        return state
    finally:
        con.close()
