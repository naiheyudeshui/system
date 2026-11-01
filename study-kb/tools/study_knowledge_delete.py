"""Physical knowledge deletion with transactional, conflict-checked undo snapshots."""
import json

ITEM = "study_knowledge_item"
RELATED = {"schedules": ("study_knowledge_schedule", "item_id"),
           "reviews": ("study_knowledge_review_log", "item_id"),
           "scopes": ("study_knowledge_scope", "anchor_item_id")}
FIELDS = ("id", "parent_id", "sort_order", "title", "content_md", "status")


def _rows(con, table, field, ids):
    return [dict(row) for row in con.execute(f"SELECT * FROM {table}") if row[field] in ids]


def capture(con, ids):
    ids = set(ids)
    return {"items": _rows(con, ITEM, "id", ids),
            **{key: _rows(con, table, field, ids) for key, (table, field) in RELATED.items()}}


def _ordered(items):
    pending = {row["id"]: row for row in items}
    ordered = []
    while pending:
        ready = [row for row in pending.values() if row["parent_id"] not in pending]
        if not ready:
            raise ValueError("Cannot delete a cyclic knowledge graph")
        for row in ready:
            ordered.append(row)
            pending.pop(row["id"])
    return ordered


def remove(con, snapshot):
    ids = {row["id"] for row in snapshot["items"]}
    # Explicit child-before-parent order handles RESTRICT foreign keys without
    # disabling foreign-key enforcement or relying on SQL row iteration order.
    for _, (table, field) in RELATED.items():
        con.executemany(f"DELETE FROM {table} WHERE {field}=?", [(key,) for key in ids])
    for row in reversed(_ordered(snapshot["items"])):
        con.execute(f"DELETE FROM {ITEM} WHERE id=?", (row["id"],))


def history(snapshot, survivors=(), *, action="restore"):
    restoring = action == "delete"
    delta = [{"before": None if restoring else row, "after": row if restoring else None}
             for row in snapshot["items"]]
    delta.extend(survivors)
    return {"history_delta": delta,
            "physical_delete": {"action": action, "records": snapshot, "survivors": list(survivors)}}


def _same_rows(left, right):
    encode = lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return sorted(map(encode, left)) == sorted(map(encode, right))


def restore_history(con, data):
    from study_knowledge_edit import KnowledgeConflict
    physical = data["physical_delete"]
    records, changes = physical["records"], physical["survivors"]
    ids = {row["id"] for row in records["items"]}
    restoring = physical["action"] == "restore"
    for change in changes:
        expected = change["after"]
        current = con.execute(f"SELECT {','.join(FIELDS)} FROM {ITEM} WHERE id=?", (expected["id"],)).fetchone()
        if not current or dict(current) != expected:
            raise KnowledgeConflict("删除涉及的子节点已有新修改，未覆盖当前数据")
    if restoring:
        if any(con.execute(f"SELECT 1 FROM {ITEM} WHERE id=?", (key,)).fetchone() for key in ids):
            raise KnowledgeConflict("原节点 ID 已重新使用，不能覆盖恢复")
        for row in records["items"]:
            parent = row["parent_id"]
            if parent and parent not in ids:
                found = con.execute(f"SELECT status FROM {ITEM} WHERE id=?", (parent,)).fetchone()
                if not found or found[0] != "active":
                    raise KnowledgeConflict("原父节点已被删除或停用，请先恢复父节点")
        for key, table in (("items", ITEM), *[(key, value[0]) for key, value in RELATED.items()]):
            content = _ordered(records[key]) if key == "items" else records[key]
            for row in content:
                columns = list(row)
                con.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", tuple(row[column] for column in columns))
    else:
        current = capture(con, ids)
        if any(not _same_rows(current[key], records[key]) for key in records):
            raise KnowledgeConflict("恢复后节点或复习记录已变化，不能重做删除")
        allowed_children = ids | {change["after"]["id"] for change in changes}
        if any(row[0] not in allowed_children and row[1] in ids for row in con.execute(f"SELECT id,parent_id FROM {ITEM}")):
            raise KnowledgeConflict("节点下新增了子节点，不能重做删除")
    inverse = []
    for change in changes:
        row = change["before"]
        con.execute(f"UPDATE {ITEM} SET parent_id=?,sort_order=?,title=?,content_md=?,status=?,updated_at=datetime('now','localtime') WHERE id=?",
                    tuple(row[key] for key in FIELDS[1:]) + (row["id"],))
        inverse.append({"before": change["after"], "after": change["before"]})
    if not restoring:
        remove(con, records)
    from study_api import build_knowledge_tree
    build_knowledge_tree(con)
    return {"node": {"node_id": records["items"][0]["id"], "deleted": not restoring}, "history_available": True}, history(records, inverse, action="delete" if restoring else "restore")


def classify_archived_deletions(con):
    """Only classify archived rows tied to actual deletes/undo or their children."""
    all_items = {row["id"]: dict(row) for row in con.execute(f"SELECT * FROM {ITEM}")}
    known = set()
    for row in con.execute("SELECT operation,before_json,result_json FROM study_knowledge_edit"):
        before, result = json.loads(row["before_json"]), json.loads(row["result_json"])
        if row["operation"] == "delete":
            known.add(result.get("node", {}).get("node_id"))
        for delta in before.get("history_delta", []):
            after = delta.get("after")
            if after and after.get("status") == "archived":
                known.add(after["id"])
    archived = {key for key, row in all_items.items() if row["status"] == "archived"}
    confirmed = archived & known
    while True:
        descendants = {key for key in archived if all_items[key]["parent_id"] in confirmed}
        if descendants <= confirmed:
            break
        confirmed.update(descendants)
    if any(row["parent_id"] in confirmed and key not in confirmed for key, row in all_items.items()):
        raise ValueError("An archived deletion still owns a surviving child; explicit reparenting required")
    return confirmed, archived - confirmed
