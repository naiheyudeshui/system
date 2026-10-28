"""Transactional edits for canonical knowledge nodes without touching review state."""

import hashlib
import json
import uuid

from study_kb import create_node, open_db


class KnowledgeConflict(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


HISTORY_FIELDS = ("id", "parent_id", "sort_order", "title", "content_md", "status")


def history_snapshot(con):
    return {row["id"]: {key: row[key] for key in HISTORY_FIELDS}
            for row in con.execute("SELECT * FROM study_knowledge_item")}


def history_restore(con, payload):
    record = con.execute("SELECT before_json FROM study_knowledge_edit WHERE request_id=?",
                         (payload.get("target_request_id"),)).fetchone()
    delta = json.loads(record[0]).get("history_delta") if record else None
    if not delta:
        raise ValueError("该操作没有可撤销的历史")
    current = history_snapshot(con)
    for change in delta:
        if current.get(change["after"]["id"]) != change["after"]:
            raise KnowledgeConflict("相关节点已被其他操作修改，请刷新；未覆盖当前数据")
    expected = {change["before"]["id"]: change["before"] for change in delta}
    for row in expected.values():
        if row["status"] == "active" and row["parent_id"]:
            parent = expected.get(row["parent_id"], current.get(row["parent_id"]))
            if not parent or parent["status"] != "active":
                raise KnowledgeConflict("原父节点已被停用，不能恢复到不可见位置；请先恢复父节点")
    archiving = {key for key, row in expected.items() if row["status"] != "active"}
    if any(row["status"] == "active" and row["parent_id"] in archiving
           for key, value in current.items() for row in [expected.get(key, value)]):
        raise KnowledgeConflict("节点下出现了新的活动子节点，不能撤销；未覆盖当前数据")
    for change in delta:
        row = change["before"]
        con.execute("""UPDATE study_knowledge_item
            SET parent_id=?,sort_order=?,title=?,content_md=?,status=?,updated_at=datetime('now','localtime')
            WHERE id=?""", tuple(row[key] for key in HISTORY_FIELDS[1:]) + (row["id"],))
    from study_api import build_knowledge_tree
    build_knowledge_tree(con)
    return {"node": {"node_id": delta[0]["before"]["id"]}, "history_available": True}, [
        {"before": change["after"], "after": change["before"]} for change in delta]


def read_node(con, key):
    if not isinstance(key, str) or len(key) > 200:
        raise ValueError("节点 ID 不合法")
    row = con.execute("SELECT * FROM v_study_knowledge_nodes WHERE node_id=?", (key,)).fetchone()
    if row is None:
        raise ValueError("节点不存在、已停用或不属于可编辑知识库")
    node = dict(row)
    return {"node": node, "version": fingerprint(node)}


def read_knowledge_node(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求必须是对象")
    con = open_db()
    try:
        return read_node(con, payload.get("node_id"))
    finally:
        con.close()


def edit_knowledge(con, payload):
    if not isinstance(payload, dict):
        raise ValueError("请求必须是对象")
    operation = payload.get("operation")
    if operation not in {"child", "sibling", "content", "move", "reorder", "delete", "history"}:
        raise ValueError("未知的节点操作")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not 8 <= len(request_id) <= 100:
        raise ValueError("缺少有效的请求 ID")
    content = payload.get("content_md", "")
    if not isinstance(content, str) or len(content) > 200000:
        raise ValueError("Markdown 内容必须是文本且不超过 200000 字符")
    title = payload.get("title", "")
    if operation in {"child", "sibling"} and (not isinstance(title, str) or not title.strip() or len(title) > 500):
        raise ValueError("标题必填且不超过 500 字符")
    target = payload.get("target_node_id")
    if operation in {"move", "reorder"} and (not isinstance(target, str) or not target or target == payload.get("node_id")):
        raise ValueError("移动操作必须指定不同的目标节点")
    if operation == "delete" and payload.get("delete_mode") not in {"self", "recursive"}:
        raise ValueError("删除必须明确选择仅删除自身或递归删除")
    request_hash = fingerprint(payload)
    previous = con.execute("SELECT request_hash,result_json FROM study_knowledge_edit WHERE request_id=?", (request_id,)).fetchone()
    if previous:
        if previous["request_hash"] != request_hash:
            raise KnowledgeConflict("请求 ID 已用于其他修改，请重新打开编辑器")
        return json.loads(previous["result_json"])
    if operation == "history":
        result, delta = history_restore(con, payload)
        con.execute("INSERT INTO study_knowledge_edit(request_id,request_hash,operation,before_json,result_json) VALUES (?,?,?,?,?)",
                    (request_id, request_hash, operation, encoded({"history_delta": delta}), encoded(result)))
        return result
    items_before = history_snapshot(con)
    before = read_node(con, payload.get("node_id"))
    if payload.get("version") != before["version"]:
        raise KnowledgeConflict("节点已被修改，请重新打开编辑器；当前草稿未覆盖数据库")
    node = before["node"]
    if operation in {"move", "reorder"}:
        destination = read_node(con, target)["node"]
        cursor = destination["node_id"]
        while cursor is not None:
            if cursor == node["node_id"]:
                raise ValueError("不能将节点移动到自身或其后代下")
            parent_row = con.execute("SELECT parent_id FROM v_study_knowledge_nodes WHERE node_id=?", (cursor,)).fetchone()
            cursor = parent_row[0] if parent_row else None
    if operation == "content":
        next_title = node["title"]
        if "title" in payload:
            if not isinstance(title, str) or not title.strip() or len(title) > 500:
                raise ValueError("标题必填且不超过 500 字符")
            next_title = title.strip()
        con.execute("UPDATE study_knowledge_item SET title=?,content_md=?,updated_at=datetime('now','localtime') WHERE id=?", (next_title, content, node["node_id"]))
        key = node["node_id"]
    elif operation in {"child", "sibling"}:
        parent_key = node["node_id"] if operation == "child" else node["parent_id"]
        parent = read_node(con, parent_key)["node"] if parent_key else None
        parent_id = parent["node_id"] if parent else None
        order = con.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM v_study_knowledge_nodes WHERE parent_id IS ?", (parent_key,)).fetchone()[0]
        parent_legacy = parent["source_id"] if parent and parent["source_type"] == "node" else None
        created = create_node(con, title=title.strip(), kind="topic", parent_id=parent_key,
                              role="topic" if content.strip() else "outline", answer_md=content, source_ref=node["source_ref"], sort_order=order)
        key = ("card:" + created["card_id"]) if created.get("card_id") else ("node:" + created["id"])
        from study_api import build_knowledge_tree
        build_knowledge_tree(con)
    elif operation == "reorder":
        destination = read_node(con, target)["node"]
        if node["parent_id"] != destination["parent_id"]:
            raise ValueError("只能调整同一父节点下的顺序")
        direction = payload.get("position")
        if direction not in {"before", "after"}:
            raise ValueError("排序操作必须指定 before 或 after")
        sibling_rows = con.execute("SELECT id FROM study_knowledge_item WHERE parent_id IS ? AND id != ? AND status='active' ORDER BY sort_order,title,id", (destination["parent_id"], node["node_id"])).fetchall()
        ordered = [row[0] for row in sibling_rows]
        position = ordered.index(destination["node_id"]) + (1 if direction == "after" else 0)
        ordered.insert(position, node["node_id"])
        for sort_order, item_id in enumerate(ordered, start=1):
            con.execute("UPDATE study_knowledge_item SET sort_order=?,updated_at=datetime('now','localtime') WHERE id=?", (sort_order, item_id))
        key = node["node_id"]
    elif operation == "move":
        destination = read_node(con, target)["node"]
        destination_id = destination["node_id"]
        destination_key = destination_id if destination_id.startswith(("node:", "card:")) else ("card:" + destination_id if destination.get("source_type") == "card" else "node:" + destination_id)
        node_key = node["node_id"] if node["node_id"].startswith(("node:", "card:")) else ("card:" + node["node_id"] if node.get("source_type") == "card" else "node:" + node["node_id"])
        con.execute("UPDATE study_knowledge_item SET parent_id=?,sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM study_knowledge_item WHERE parent_id=?),updated_at=datetime('now','localtime') WHERE id=?", (destination_key, destination_key, node_key))
        key = node["node_id"]
    elif operation == "delete":
        # Preserve reviews: archive items and reparent children for self-only deletion.
        source_ids = [node["node_id"]]
        if payload["delete_mode"] == "recursive":
            pending = list(source_ids)
            while pending:
                current = pending.pop()
                children = [row[0] for row in con.execute("SELECT id FROM study_knowledge_item WHERE parent_id=?", (current,))]
                pending.extend(children)
                source_ids.extend(children)
        else:
            old_parent = node["parent_id"]
            fallback = None
            if old_parent:
                fallback = old_parent
            for child in con.execute("SELECT id FROM study_knowledge_item WHERE parent_id=?", (node["node_id"],)).fetchall():
                con.execute("UPDATE study_knowledge_item SET parent_id=? WHERE id=?", (fallback, child[0]))
        placeholders = ",".join("?" for _ in source_ids)
        con.execute(f"UPDATE study_knowledge_item SET status='archived',updated_at=datetime('now','localtime') WHERE id IN ({placeholders})", source_ids)
        key = node["node_id"]
    result = {"node": {"node_id": key, "deleted": True}} if operation == "delete" else read_node(con, key)
    delta = []
    for item_id, after in history_snapshot(con).items():
        old = items_before.get(item_id)
        if old != after:
            # Undo creation by archiving, never deleting schedules or review logs.
            delta.append({"before": old if old else {**after, "status": "archived"}, "after": after})
    before["history_delta"] = delta
    result["history_available"] = bool(delta)
    con.execute("INSERT INTO study_knowledge_edit(request_id,request_hash,operation,before_json,result_json) VALUES (?,?,?,?,?)",
                (request_id, request_hash, operation, encoded(before), encoded(result)))
    return result


def save_knowledge_node(payload):
    con = open_db()
    try:
        con.execute("BEGIN IMMEDIATE")
        result = edit_knowledge(con, payload)
        con.commit()
        return result
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
