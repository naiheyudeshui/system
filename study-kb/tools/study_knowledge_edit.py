"""Transactional edits for canonical knowledge nodes without touching review state."""

import hashlib
import json

from study_kb import create_node, open_db


class KnowledgeConflict(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


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
    if operation not in {"child", "sibling", "content"}:
        raise ValueError("未知的节点操作")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not 8 <= len(request_id) <= 100:
        raise ValueError("缺少有效的请求 ID")
    content = payload.get("content_md", "")
    if not isinstance(content, str) or len(content) > 200000:
        raise ValueError("Markdown 内容必须是文本且不超过 200000 字符")
    title = payload.get("title", "")
    if operation != "content" and (not isinstance(title, str) or not title.strip() or len(title) > 500):
        raise ValueError("标题必填且不超过 500 字符")
    request_hash = fingerprint(payload)
    previous = con.execute("SELECT request_hash,result_json FROM study_knowledge_edit WHERE request_id=?", (request_id,)).fetchone()
    if previous:
        if previous["request_hash"] != request_hash:
            raise KnowledgeConflict("请求 ID 已用于其他修改，请重新打开编辑器")
        return json.loads(previous["result_json"])
    before = read_node(con, payload.get("node_id"))
    if payload.get("version") != before["version"]:
        raise KnowledgeConflict("节点已被修改，请重新打开编辑器；当前草稿未覆盖数据库")
    node = before["node"]
    if operation == "content":
        if node["source_type"] == "card":
            con.execute("UPDATE study_card SET back=?,updated_at=datetime('now','localtime') WHERE id=?", (content, node["source_id"]))
        else:
            con.execute("UPDATE study_node SET answer_md=?,updated_at=datetime('now','localtime') WHERE id=?", (content, node["source_id"]))
        key = node["node_id"]
    else:
        parent_key = node["node_id"] if operation == "child" else node["parent_id"]
        parent = read_node(con, parent_key)["node"] if parent_key else None
        parent_id = parent["owner_node_id"] if parent else None
        if parent and parent["source_type"] == "node":
            parent_id = parent["source_id"]
        order = con.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM v_study_knowledge_nodes WHERE parent_id IS ?", (parent_key,)).fetchone()[0]
        created = create_node(con, title=title.strip(), kind="topic", parent_id=parent_id,
                              role="outline", answer_md=content, source_ref=node["source_ref"], sort_order=order)
        if parent and parent["source_type"] == "card":
            con.execute("INSERT INTO study_node_parent_card(node_id,parent_card_id) VALUES (?,?)", (created["id"], parent["source_id"]))
        key = "node:" + created["id"]
        from study_api import build_knowledge_tree
        build_knowledge_tree(con)
    result = read_node(con, key)
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
