"""Trusted, versioned export of the built-in knowledge tree (no arbitrary SQL).

Only the selected subtree, its schedules, review facts, scopes and explicit asset
links are portable here. In-progress review sessions and arbitrary saved SQL
schemes are not claimed as portable by this adapter.
"""
import re
import os
import uuid

from file_assets import FileAssets, canonical_asset_id
from file_bundles import BundleError, register_adapter
from file_references import markdown_asset_ids, rewrite_markdown_assets

ADAPTER = "study.knowledge-subtree/v1"
_LINK = re.compile(r"wb-asset://([^\s\)\]\}>\"']+)", re.I)
_COLUMNS = {
    "items": ("id", "item_type", "parent_id", "sort_order", "title", "content_md", "source_ref", "status", "card_type", "hint", "legacy_node_id", "legacy_card_id", "created_at", "updated_at"),
    "schedules": ("item_id", "due_at", "stability", "difficulty", "reps", "lapses", "state_json", "updated_at"),
    "reviewLogs": ("id", "item_id", "rating", "reviewed_at", "elapsed_ms", "before_state_json", "after_state_json"),
    "scopes": ("id", "anchor_item_id", "label", "is_default", "created_at"),
}
_TABLES = {"items": "study_knowledge_item", "schedules": "study_knowledge_schedule",
           "reviewLogs": "study_knowledge_review_log", "scopes": "study_knowledge_scope"}


def _source_asset_ids(value):
    # source_ref is a plain provenance string, not a Markdown document.
    return {canonical_asset_id(match.group(1).lower()) for match in _LINK.finditer(value or "")}


def _item_asset_ids(item):
    return (set(markdown_asset_ids(item.get("content_md"))) |
            set(markdown_asset_ids(item.get("hint"))) |
            _source_asset_ids(item.get("source_ref")))


def _rows(connection, category, ids, field):
    # Explicit allowlisted tables, no user SQL or preview LIMIT.
    columns = _COLUMNS[category]
    return [{column: row[index] for index, column in enumerate(columns)}
            for row in connection.execute(f'SELECT {",".join(columns)} FROM {_TABLES[category]} ORDER BY rowid')
            if row[columns.index(field)] in ids]


def _context(context):
    if context["workspaceId"] != "study" or context["scope"] != "unit":
        raise BundleError("Study knowledge bundles require the Study workspace and unit scope")


def export_subtree(connection, selection, *, context):
    _context(context)
    root = selection.get("id")
    if not isinstance(root, str) or not root:
        raise BundleError("Select one built-in knowledge-tree root id")
    if selection.get("pluginId") not in (None, "", "study.tree", "study.tree-view", "study.knowledge"):
        raise BundleError("This adapter only exports the built-in Study knowledge tree")
    row = connection.execute("SELECT id FROM study_knowledge_item WHERE id=? OR legacy_node_id=? OR legacy_card_id=?", (root, root, root)).fetchone()
    if not row:
        raise BundleError("Knowledge-tree root does not exist")
    root = row[0]
    ids = {row[0] for row in connection.execute(
        "WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT i.id FROM study_knowledge_item i JOIN descendants d ON i.parent_id=d.id) SELECT id FROM descendants", (root,))}
    data = {"schema": ADAPTER, "roots": [root], "items": _rows(connection, "items", ids, "id"),
            "schedules": _rows(connection, "schedules", ids, "item_id"),
            "reviewLogs": _rows(connection, "reviewLogs", ids, "item_id"),
            "scopes": _rows(connection, "scopes", ids, "anchor_item_id"),
            "excluded": ["in-progress review sessions", "arbitrary SQL schemes", "timer data outside this tree"]}
    assets = set()
    for item in data["items"]:
        if item["parent_id"] not in ids:
            item["parent_id"] = None
        assets.update(_item_asset_ids(item))
    return {"data": data, "assetIds": sorted(assets), "dependencies": [{"pluginId": "study.tree", "adapter": ADAPTER}]}


def import_subtree(connection, data, asset_map, *, context):
    _context(context)
    if not isinstance(data, dict) or data.get("schema") != ADAPTER or set(data) != {"schema", "roots", "items", "schedules", "reviewLogs", "scopes", "excluded"}:
        raise BundleError("Unsupported Study knowledge records")
    for category, columns in _COLUMNS.items():
        if not isinstance(data[category], list) or any(not isinstance(row, dict) or set(row) != set(columns) for row in data[category]):
            raise BundleError("Study record columns differ from the versioned adapter")
    items = data["items"]
    ids = {row["id"] for row in items}
    if not ids or len(ids) != len(items) or not isinstance(data["roots"], list) or set(data["roots"]) - ids:
        raise BundleError("Invalid knowledge identities/roots")
    by_id = {row["id"]: row for row in items}
    for item in items:
        visited = set()
        current = item["id"]
        while current:
            if current in visited or current not in by_id:
                raise BundleError("Invalid or cyclic knowledge parent relationship")
            visited.add(current)
            current = by_id[current]["parent_id"]
    for category, field in (("schedules", "item_id"), ("reviewLogs", "item_id"), ("scopes", "anchor_item_id")):
        if any(row[field] not in ids for row in data[category]):
            raise BundleError("Knowledge history references an unselected record")
    actual_assets = set()
    for row in items:
        actual_assets.update(_item_asset_ids(row))
    if actual_assets != set(asset_map):
        raise BundleError("Knowledge attachment closure differs from bundle assets")
    mapping = {source: ("card:" if by_id[source]["item_type"] == "card" else "node:") + uuid.uuid4().hex for source in ids}
    # Inserting a complete known graph in one transaction permits child-first
    # source order without losing parents or turning them into root nodes.
    connection.execute("PRAGMA defer_foreign_keys=ON")
    for category, columns in _COLUMNS.items():
        for source in data[category]:
            row = dict(source)
            if category == "items":
                row["id"] = mapping[source["id"]]
                row["parent_id"] = mapping.get(source["parent_id"])
                row["legacy_node_id"] = row["id"].removeprefix("node:") if source["legacy_node_id"] is not None else None
                row["legacy_card_id"] = row["id"].removeprefix("card:") if source["legacy_card_id"] is not None else None
                for field in ("content_md", "hint"):
                    row[field] = rewrite_markdown_assets(row[field], asset_map)
                row["source_ref"] = _LINK.sub(lambda match: "wb-asset://" + asset_map[match.group(1).lower()], row["source_ref"] or "")
            elif category == "schedules":
                row["item_id"] = mapping[source["item_id"]]
            elif category == "reviewLogs":
                row["id"] = "review_" + uuid.uuid4().hex
                row["item_id"] = mapping[source["item_id"]]
            else:
                row["id"] = "scope_" + uuid.uuid4().hex
                row["anchor_item_id"] = mapping[source["anchor_item_id"]]
                # Importing a second collection must not steal the default scope.
                row["is_default"] = 0
            connection.execute(f'INSERT INTO {_TABLES[category]}({",".join(columns)}) VALUES({",".join("?" for _ in columns)})', tuple(row[column] for column in columns))
            if category == "items":
                assets = _item_asset_ids(row)
                if assets:
                    # Same owner shape as normal knowledge saves. Files and rows
                    # commit together; no separate post-save request is involved.
                    files = context["files"]
                    files.replace_references(connection, "study-item", row["id"], assets)
                    from file_references import bind_study_owner
                    bind_study_owner(connection, "study-item", row["id"])
    return {"adapter": ADAPTER, "roots": [mapping[root] for root in data["roots"]], "recordMap": mapping,
            "counts": {category: len(data[category]) for category in _COLUMNS}, "excluded": data["excluded"]}


def install():
    register_adapter(ADAPTER, export_subtree, import_subtree, workspace_aware=True)


def tree_roots():
    import db
    from contextlib import closing
    with closing(db.connect()) as connection:
        rows = connection.execute("SELECT id,title FROM study_knowledge_item WHERE parent_id IS NULL ORDER BY sort_order,title,id")
        return {"adapter": ADAPTER, "roots": [{"id": row[0], "title": row[1]} for row in rows],
                "excluded": ["in-progress review sessions", "arbitrary SQL schemes", "unrelated timers"],
                "maxLogicalDataBytes": 8 * 1024**2}
