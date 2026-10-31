"""Study's explicit reference extractors. Invoked only on user-requested audit."""
from file_reference_audit import exists


UNIT = {"pluginId": "study.node-tree", "moduleId": "knowledge-library", "key": "builtin", "name": "内置知识库及保留历史"}


def _refs(audit, row):
    if not isinstance(row, dict): raise ValueError("Invalid knowledge record")
    return sorted(set(audit.links(row.get("content_md"))) | set(audit.links(row.get("hint"))) |
                  set(audit.links(row.get("source_ref"), plain=True)))


def scan(audit):
    con = audit.con
    if audit.files.workspace_id != "study" or not exists(con, "study_knowledge_item"): return
    source = "study_knowledge_item"
    if not {"id", "content_md", "hint", "source_ref"} <= {row[1] for row in con.execute("PRAGMA table_info(study_knowledge_item)")}:
        audit.issue("unsupported-knowledge-schema", "study-knowledge")
        return
    current = set()
    for row in con.execute("SELECT id,content_md,hint,source_ref FROM study_knowledge_item ORDER BY id"):
        current.add(row["id"])
        try:
            refs = _refs(audit, dict(row))
        except (ValueError, TypeError):
            from file_reference_audit import MAX_TEXT_BYTES
            if audit.text_bytes > MAX_TEXT_BYTES: raise
            audit.issue("invalid-knowledge-record", "study-knowledge", blocking=True)
            continue
        audit.add("study-item", row["id"], refs, sourceTable=source, unit=UNIT)
    for row in con.execute("SELECT owner_id FROM wb_file_reference_owner WHERE workspace_id='study' AND owner_kind='study-item'"):
        if row[0] not in current:
            audit.add("study-item", row[0], [], sourceTable=source, unit=UNIT)
    audit.sources.add("study:knowledge-current")
    if not exists(con, "study_knowledge_edit"): return
    if not {"request_id", "before_json"} <= {row[1] for row in con.execute("PRAGMA table_info(study_knowledge_edit)")}:
        audit.issue("unsupported-knowledge-history-schema", "study-history")
        return
    for row in con.execute("SELECT request_id,before_json FROM study_knowledge_edit ORDER BY request_id"):
        try:
            data = audit.json(row["before_json"])
            if not isinstance(data, dict): raise ValueError("Invalid knowledge history")
            delta = data.get("history_delta")
            if delta is None:
                # Older edit formats do not declare a complete restorable delta.
                # Index any declared prior content, but retain additional refs.
                audit.add("study-history", row["request_id"], _refs(audit, data), preserveExisting=True, sourceTable=source, unit=UNIT)
                audit.issue("legacy-history-incomplete", "study-history")
                continue
            if not isinstance(delta, list): raise ValueError("Invalid knowledge history")
            refs = set()
            for item in delta:
                if not isinstance(item, dict) or set(item) - {"id", "before", "after"}:
                    raise ValueError("Unknown history delta")
                for field in ("before", "after"):
                    if item.get(field) is not None: refs.update(_refs(audit, item[field]))
            audit.add("study-history", row["request_id"], refs, sourceTable=source, unit=UNIT)
        except (ValueError, TypeError, RecursionError):
            from file_reference_audit import MAX_TEXT_BYTES, MAX_OWNERS
            if audit.text_bytes > MAX_TEXT_BYTES or len(audit.owners) > MAX_OWNERS: raise
            audit.issue("invalid-knowledge-history", "study-history", blocking=True)
    audit.sources.add("study:knowledge-history")
