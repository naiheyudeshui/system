"""Study adapters for optional shared SQL configuration modules."""

from __future__ import annotations

import json
import sys
import uuid
import time
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[2] / "3dStudio" / "tools"))
sys.path.append(str(Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"))

from plugin_workspace import register_module
from workbench_plugins import configs, query_rows, seed_configs, validate_result
from study_kb import open_db
from study_selection import normalize as normalize_policy, select as select_items, digest
from study_learning import enrich
from plugin_data_authoring import register_data_delete_guard


def validate_content_deletion(con, table, collection_id, removed):
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='study_knowledge_review_session_item'").fetchone():
        return
    for item in con.execute("SELECT i.item_json,s.config_json FROM study_knowledge_review_session_item i JOIN study_knowledge_review_session s ON s.id=i.session_id WHERE i.result_json IS NULL"):
        active, config = json.loads(item[0]), json.loads(item[1])
        if not config.get('ended_at') and (active.get('collection_id') == collection_id or config.get('scheduler', {}).get('table') == table) and active.get('key') in removed:
            from workbench_plugins import ConflictError
            raise ConflictError('这些记录仍在未完成的复习中，请先结束该轮')


NODE_SUBTREE = """WITH RECURSIVE subtree(id) AS (
      SELECT id FROM study_knowledge_item
      WHERE id=:node_id OR legacy_node_id=:node_id OR legacy_card_id=:node_id
      UNION SELECT child.id FROM study_knowledge_item child JOIN subtree ON child.parent_id=subtree.id
    )"""
NODE_FILTER = f"""(:node_id IS NULL OR EXISTS (
    {NODE_SUBTREE}
    SELECT 1 FROM subtree WHERE id = node_id OR id = 'card:' || card_id))"""
PREVIOUS_NODE_FILTER = """(:node_id IS NULL OR node_id IN (
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM study_knowledge_item
      WHERE id=:node_id OR legacy_node_id=:node_id OR legacy_card_id=:node_id
      UNION SELECT child.id FROM study_knowledge_item child JOIN subtree ON child.parent_id=subtree.id
    ) SELECT id FROM subtree))"""
DEFAULTS = [
    {"id": "study.review.chapters.v1", "name": "章节卡片", "sql": f"""SELECT card_id, front AS question,
    COALESCE(NULLIF(back,''), answer_md) AS answer, hint, node_id
FROM v_study_node_cards
WHERE {NODE_FILTER}
ORDER BY CASE WHEN due_at <= datetime('now','localtime') THEN 0 ELSE 1 END,
         due_at ASC, lapses DESC, difficulty DESC, node_title, card_id""", "parameters": {"node_id": None}, "settings": {"scheduler": {"kind": "fsrs"}, "limit": 5000}},
    {"id": "study.review.due.v1", "name": "今日到期", "sql": f"""SELECT card_id, front AS question,
    COALESCE(NULLIF(back,''), answer_md) AS answer, hint, node_id
FROM v_study_due_cards
WHERE {NODE_FILTER}
ORDER BY due_at, card_id""", "parameters": {"node_id": None}, "settings": {"scheduler": {"kind": "fsrs"}, "limit": 5000}},
]
TREE_DEFAULTS = [{"id": "study.tree.default.v1", "name": "全部章节", "sql": "SELECT * FROM v_study_knowledge_nodes ORDER BY sort_order,title,node_id"}]


def validate_review_binding(con, payload, result):
    """A syntactically valid projection must also be usable by the scheduler."""
    from study_review_engine import validate_config
    scheduler = payload["settings"].get("scheduler", {"kind": "fsrs"})
    normalize_policy(payload['settings'].get('selectionPolicy'), legacy_random=payload['settings'].get('random', False), limit=payload['settings'].get('limit', 5000))
    validate_config(con, {"view": "v_study_node_cards", "mode": "all", "mapping": {"key": "card_id", "front": "front", "back": "back"}, "scheduler": scheduler})
    if scheduler["kind"] == "fsrs":
        for row in result["rows"]:
            if not con.execute("SELECT 1 FROM study_knowledge_item i JOIN study_knowledge_schedule s ON s.item_id=i.id WHERE i.legacy_card_id=? AND i.status='active'", (row["card_id"],)).fetchone():
                raise ValueError("此表包含不属于学习库的卡片；请选择自定义表的到期时间列，或新建独立复习表")


def knowledge_tree_source(saved):
    # Both the preset and an explicit binding to its canonical view use the
    # product adapter, which preserves schedules, history and file references.
    source = saved.get("settings", {}).get("dataSource", {})
    mapping = source.get("mapping", {})
    if source.get("mode") == "existing" and source.get("name") == "v_study_knowledge_nodes":
        return all(mapping.get(key) == key for key in ("node_id", "parent_id", "title", "content_md"))
    return not saved.get("parameters") and not saved.get("settings") and "".join(saved["sql"].lower().split()) == "".join(TREE_DEFAULTS[0]["sql"].lower().split())


def validate_tree_binding(con, payload, result):
    if not knowledge_tree_source(payload):
        from plugin_tree_edit import describe
        describe(con, {**payload, "id": payload.get("id", "draft")})


def register_study_modules():
    register_data_delete_guard('study-review/v1', validate_content_deletion)
    for default in DEFAULTS:
        default["contract_version"] = "review-cards/v1"
    for default in TREE_DEFAULTS:
        default["contract_version"] = "tree-nodes/v1"
    register_module("study.review-table", "reviews", contract="review-cards/v1", label="复习方案", defaults=DEFAULTS, data_template="review-basic/v1", binding_validator=validate_review_binding, file_workspace="study")
    register_module("study.node-tree", "trees", contract="tree-nodes/v1", label="章节树方案", defaults=TREE_DEFAULTS, data_template="tree-basic/v1", binding_validator=validate_tree_binding, tree_file_workspace="study")


register_study_modules()


def _compact(sql: str) -> str:
    return " ".join(sql.split())


def _upgrade_builtin_review_sql(con, item):
    if not item:
        return item
    default = next((entry for entry in DEFAULTS if entry["id"] == item["id"]), None)
    if not default:
        return item
    current = _compact(item["sql"])
    target = _compact(default["sql"])
    previous = _compact(default["sql"].replace(NODE_FILTER, PREVIOUS_NODE_FILTER))
    if current == target or current != previous:
        return item
    con.execute(
        "UPDATE workbench_plugin_config SET sql=?, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND sql=?",
        (default["sql"], item["id"], item["sql"]),
    )
    item["sql"] = default["sql"]
    item["revision"] = item.get("revision", 0) + 1
    return item


def read_config(con, key):
    seed_configs(con, "study.review-table", "reviews", DEFAULTS)
    item = next((entry for entry in configs(con, "study.review-table", "reviews") if entry["id"] == key), None)
    item = _upgrade_builtin_review_sql(con, item)
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
        result = tree_result(query_rows(con, saved["sql"], saved["parameters"], limit=5000, seconds=5, byte_limit=16*1048576), saved["settings"])
        if knowledge_tree_source(saved):
            result["editing"] = {"provider": "study-knowledge/v1"}
        else:
            from plugin_tree_edit import describe, order_result
            result["editing"] = describe(con, saved)
            order_result(con, saved, result)
        return result
    finally:
        con.close()


def sql_review(payload, *, preview=False):
    from study_review_engine import identifier, session_state, validate_config
    con = open_db()
    try:
        source_session_id = payload.get("source_session_id")
        # 从旧会话复制同一批卡片开新轮：不依赖当前到期预览（评分后 due_at 会变，preview_hash 必失效）
        if source_session_id and not preview:
            if not isinstance(source_session_id, str) or not source_session_id.strip():
                raise ValueError("无效的来源复习会话")
            try:
                con.execute("BEGIN IMMEDIATE")
                previous = con.execute(
                    "SELECT config_json FROM study_knowledge_review_session WHERE id=?",
                    (source_session_id.strip(),),
                ).fetchone()
                if not previous:
                    raise ValueError("来源复习会话不存在")
                configuration = json.loads(previous["config_json"])
                item_rows = con.execute(
                    "SELECT position, item_json FROM study_knowledge_review_session_item WHERE session_id=? ORDER BY position",
                    (source_session_id.strip(),),
                ).fetchall()
                if not item_rows:
                    raise ValueError("来源复习会话没有卡片")
                items = [json.loads(row["item_json"]) for row in item_rows]
                selected_keys = configuration.get("selected_keys")
                if not isinstance(selected_keys, list) or not selected_keys:
                    selected_keys = [item.get("key") for item in items if item.get("key") is not None]

                current_saved = read_config(con, configuration.get('config_id'))
                settings = current_saved['settings']
                policy = normalize_policy(settings.get('selectionPolicy') or (None if settings.get('random') else {'order': 'legacy_reps_due'}), legacy_random=settings.get('random', False), limit=settings.get('limit', 5000))
                seed = uuid.uuid4().hex
                scheduler = configuration['scheduler']
                items = [updated for item in items if (updated := enrich(con, item, scheduler)) is not None]
                items, _ = select_items(items, policy, seed)

                configuration = {
                    **configuration,
                    "selected_keys": selected_keys,
                    "source_session_id": source_session_id.strip(),
                    "selectionPolicy": policy, "selection_seed": seed,
                }
                configuration.pop('ended_at', None)
                session_id = uuid.uuid4().hex
                con.execute(
                    "INSERT INTO study_knowledge_review_session (id,config_json) VALUES (?,?)",
                    (session_id, json.dumps(configuration, ensure_ascii=False)),
                )
                con.executemany(
                    "INSERT INTO study_knowledge_review_session_item (session_id,position,item_json) VALUES (?,?,?)",
                    [(session_id, position, json.dumps(item, ensure_ascii=False)) for position, item in enumerate(items)],
                )
                state = session_state(con, session_id)
                from study_review_units import register_session
                register_session(con, session_id, configuration, active=bool(items))
                con.commit()
                return state
            except Exception:
                con.rollback()
                raise

        saved = read_config(con, payload.get("config_id"))
        con.commit()
        try:
            con.execute("BEGIN" if preview else "BEGIN IMMEDIATE")
            parameters = payload.get("parameters", saved["parameters"])
            settings = saved["settings"]
            configuration = validate_config(con, {
                "view": "v_study_node_cards", "mode": "all", "mapping": {"key": "card_id", "front": "front", "back": "back"},
                "limit": settings.get("limit", 5000), "scheduler": settings.get("scheduler", {"kind": "fsrs"}),
                "selectionPolicy": settings.get('selectionPolicy'), "random": settings.get('random', False),
            })
            result = validate_result(query_rows(con, saved["sql"], parameters, limit=50000, seconds=5, byte_limit=16*1048576), "review-cards/v1")
            if result["truncated"]:
                raise ValueError("超过 50000 条候选，请在 SQL 中缩小范围")
            scheduler = configuration["scheduler"]
            node_paths = {}
            if "node_id" in result["columns"]:
                nodes = {node["id"]: node for node in con.execute("SELECT legacy_node_id AS id, substr(parent_id,6) AS parent_id,title FROM study_knowledge_item WHERE item_type <> 'card'")}
                for node_id in {row.get("node_id") for row in result["rows"]}:
                    path, visited = [], set()
                    # Review rows carry item ids ("node:<id>"); the lookup is keyed by node id.
                    current = node_id[5:] if isinstance(node_id, str) and node_id.startswith("node:") else node_id
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
                target_key = "card:" + key if scheduler["kind"] == "fsrs" else key
                due_expression = 'NULL' if scheduler['kind'] == 'learning' else identifier(scheduler['due'])
                target = con.execute(f'SELECT {identifier(scheduler["key"])}, {due_expression} FROM {identifier(scheduler["table"])} WHERE {identifier(scheduler["key"])}=?', (target_key,)).fetchone()
                if not target or (scheduler["kind"] == "fsrs" and not con.execute("SELECT 1 FROM study_knowledge_item WHERE legacy_card_id=? AND status='active'", (key,)).fetchone()):
                    missing += 1
                    continue
                key = target[0]
                if key in seen:
                    duplicates += 1
                    continue
                seen.add(key)
                item = enrich(con, {**row, 'key': key, 'front': row['question'], 'back': row['answer'], 'due_at': target[1]}, scheduler)
                if item is None:
                    continue
                preview_row = {**item, "card_id": key}
                if node_paths and "node_path" not in preview_row:
                    preview_row["node_path"] = node_paths.get(row.get("node_id"), "")
                rows.append(preview_row)
                items.append(item)
            policy = configuration['selectionPolicy']
            # Stable between preview/recheck, fresh only on explicit reshuffle/new round.
            seed = payload.get('selection_seed') or digest({'config': saved['id'], 'revision': saved['revision'], 'parameters': parameters})[:24]
            if not isinstance(seed, str) or len(seed) > 128:
                raise ValueError('无效的随机种子')
            preview_hash = digest({"revision": saved["revision"], "parameters": parameters, "rows": rows, 'policy': policy, 'seed': seed})
            selected_keys = payload.get("selected_keys")
            if selected_keys is not None:
                if not isinstance(selected_keys, list) or not selected_keys or any(not isinstance(key, (str, int, float)) or isinstance(key, bool) for key in selected_keys):
                    raise ValueError("请选择至少一张预览卡片")
                if payload.get("preview_hash") != preview_hash:
                    raise ValueError("方案或候选数据已变化，请重新预览后开始")
                if len(selected_keys) != len(set(selected_keys)) or not set(selected_keys).issubset({item['key'] for item in items}):
                    raise ValueError("选择的卡片不属于当前预览或存在重复")
                selected_set = set(selected_keys)
                items = [item for item in items if item["key"] in selected_set]
            # Recheck selected IDs before ordering/limit; filters apply to the full SQL result.
            items, matched = select_items(items, policy, seed)
            all_ordered, _ = select_items([{**item} for item in rows], {**policy, 'limit': 5000}, seed)
            if len(rows) > 5000:
                all_ordered, _ = select_items(rows, {**policy, 'limit': len(rows)}, seed)
            preview_rows = [{k: v for k, v in row.items() if k not in {'front', 'back', 'key'}} for row in all_ordered]
            if preview:
                con.commit()
                return {"matched": matched, "selected": len(items), "duplicates": duplicates, "missing_schedule": missing, "sample": items[:5], "rows": preview_rows, "columns": list(dict.fromkeys([*result["columns"], "due_at", 'learning_enabled', 'mastery_score', 'review_count', 'lapse_count', 'created_at', *(["node_path"] if node_paths else [])])), "limit": policy['limit'], "preview_hash": preview_hash, 'selection_seed': seed, 'selectionPolicy': policy}
            configuration.update({"source": "sql", "config_id": saved["id"], "config_revision": saved["revision"], "view": saved["name"], "sql": saved["sql"], "parameters": parameters, "selected_keys": selected_keys, "preview_hash": payload.get("preview_hash"), 'selection_seed': seed})
            session_id = uuid.uuid4().hex
            con.execute("INSERT INTO study_knowledge_review_session (id,config_json) VALUES (?,?)", (session_id, json.dumps(configuration)))
            con.executemany("INSERT INTO study_knowledge_review_session_item (session_id,position,item_json) VALUES (?,?,?)", [(session_id, position, json.dumps(item)) for position, item in enumerate(items)])
            state = session_state(con, session_id)
            from study_review_units import register_session
            register_session(con, session_id, configuration, active=bool(items))
            con.commit()
            return state
        except Exception:
            con.rollback()
            raise
    finally:
        con.close()
