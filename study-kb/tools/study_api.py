"""Study-kb HTTP helpers for workbench plugins."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any

from study_kb import build_markmap_markdown, get_node, grade_card, list_due_cards, open_db

DUE_VIEWS = frozenset({"v_study_due_cards", "v_study_node_cards"})


def _row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def _view_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='view' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def build_node_tree(con: sqlite3.Connection, *, scope_id: str | None = None) -> dict[str, Any]:
    if scope_id:
        rows = con.execute(
            """
            SELECT node_id AS id, parent_id, kind, role, title, answer_md, sort_order, depth,
                   card_count, due_count, child_count, scope_label
            FROM v_study_scope_tree
            WHERE scope_id = ?
            ORDER BY depth, sort_order, title, id
            """,
            (scope_id,),
        ).fetchall()
    else:
        rows = con.execute(
            """
            SELECT
              n.id,
              n.parent_id,
              n.kind,
              n.role,
              n.title,
              n.answer_md,
              n.sort_order,
              (
              SELECT COUNT(*) FROM study_knowledge_item child WHERE child.parent_id = n.id AND child.status='active'
              ) AS child_count,
              (
                SELECT COUNT(*)
                FROM study_knowledge_item sc
                WHERE sc.parent_id = n.id AND sc.item_type='card' AND sc.status = 'active'
              ) AS card_count,
              (
                SELECT COUNT(*)
                FROM study_knowledge_item sc
                JOIN study_knowledge_schedule f ON f.item_id = sc.id
                WHERE sc.parent_id = n.id
                  AND sc.item_type='card' AND sc.status = 'active'
                  AND f.due_at <= datetime('now', 'localtime')
              ) AS due_count
            FROM study_knowledge_item n
            WHERE n.status='active'
            ORDER BY n.sort_order, n.title, n.id
            """
        ).fetchall()

    nodes = [_row_dict(row) or {} for row in rows]
    if nodes:
        node_ids = [node["id"] for node in nodes if node.get("id")]
        placeholders = ",".join("?" for _ in node_ids)
        cards_by_node: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in node_ids}
        if placeholders:
            for row in con.execute(
                f"""
                SELECT parent_id AS node_id, legacy_card_id AS card_id, title AS front, content_md AS back
                FROM study_knowledge_item
                WHERE parent_id IN ({placeholders}) AND item_type='card' AND status = 'active'
                ORDER BY parent_id, created_at, id
                """,
                node_ids,
            ).fetchall():
                item = _row_dict(row) or {}
                cards_by_node.setdefault(item["node_id"], []).append(item)
        for node in nodes:
            node["cards"] = cards_by_node.get(node["id"], [])
    by_id = {node["id"]: {**node, "children": []} for node in nodes}
    roots: list[dict[str, Any]] = []
    for node in by_id.values():
        parent_id = node.get("parent_id")
        if parent_id and parent_id in by_id:
            by_id[parent_id]["children"].append(node)
        else:
            roots.append(node)

    def sort_children(node: dict[str, Any]) -> None:
        node["children"].sort(key=lambda item: (item.get("sort_order") or 0, item.get("title") or ""))
        for child in node["children"]:
            sort_children(child)

    for root in roots:
        sort_children(root)
    roots.sort(key=lambda item: (item.get("sort_order") or 0, item.get("title") or ""))

    scopes = [
        _row_dict(row) or {}
        for row in con.execute(
            "SELECT id, label, is_default FROM study_knowledge_scope ORDER BY is_default DESC, label"
        ).fetchall()
    ]
    return {
        "schema": "rsim.study.tree/v1",
        "scope_id": scope_id,
        "scopes": scopes,
        "roots": roots,
        "node_count": len(nodes),
    }


def build_knowledge_tree(con: sqlite3.Connection, *, scope_id: str | None = None) -> dict[str, Any]:
    shared_python = str(Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python")
    if shared_python not in sys.path:
        sys.path.append(shared_python)
    from tree_model import tree_result

    rows = con.execute("""
        SELECT * FROM v_study_knowledge_nodes
        WHERE ? IS NULL OR owner_node_id IN (
            SELECT node_id FROM v_study_scope_tree WHERE scope_id = ?
        )
        ORDER BY sort_order, title, node_id
        LIMIT 5001
    """, (scope_id, scope_id)).fetchall()
    result = tree_result({"rows": [dict(row) for row in rows],
                          "columns": [row[1] for row in con.execute("PRAGMA table_info(v_study_knowledge_nodes)")],
                          "truncated": len(rows) > 5000},
                         {"tree": {"orphans": "root", "details": [
                             {"column": "content_md", "label": "节点内容", "format": "markdown"},
                             {"column": "source_ref", "label": "来源", "format": "text"}]}})
    result["editing"] = {"provider": "study-knowledge/v1"}
    result["scopes"] = [dict(row) for row in con.execute(
        "SELECT id, label, is_default FROM study_knowledge_scope ORDER BY is_default DESC, label")]
    return result


def _next_from_view(
    con: sqlite3.Connection,
    *,
    view: str,
    scope_id: str | None = None,
) -> dict[str, Any] | None:
    if view not in DUE_VIEWS and not _view_exists(con, view):
        raise ValueError(f"Unknown review view: {view}")

    if view == "v_study_due_cards":
        cards = list_due_cards(con, scope_id=scope_id, limit=1)
        return cards[0] if cards else None

    if scope_id:
        row = con.execute(
            f"""
            SELECT v.*
            FROM "{view.replace('"', '""')}" v
            JOIN v_study_scope_tree t ON t.node_id = v.node_id
            WHERE t.scope_id = ?
              AND v.due_at IS NOT NULL
              AND v.due_at <= datetime('now', 'localtime')
            ORDER BY v.due_at, v.card_id
            LIMIT 1
            """,
            (scope_id,),
        ).fetchone()
    else:
        row = con.execute(
            f"""
            SELECT *
            FROM "{view.replace('"', '""')}"
            WHERE due_at IS NOT NULL
              AND due_at <= datetime('now', 'localtime')
            ORDER BY due_at, card_id
            LIMIT 1
            """,
        ).fetchone()
    return _row_dict(row)


def _enrich_card(card: dict[str, Any] | None) -> dict[str, Any] | None:
    if not card:
        return None
    # Per-card back wins over node-level answer_md (multi-card nodes share one answer_md).
    if card.get("back"):
        card["answer_md"] = card["back"]
    elif card.get("answer_md"):
        card["back"] = card["answer_md"]
    return card


def get_markmap(*, scope_id: str | None = None, root_id: str | None = None) -> dict[str, Any]:
    con = open_db()
    try:
        markdown = build_markmap_markdown(con, scope_id=scope_id, root_id=root_id)
        return {
            "schema": "rsim.study.markmap/v1",
            "scope_id": scope_id,
            "root_id": root_id,
            "markdown": markdown,
        }
    finally:
        con.close()


def get_card_detail(card_id: str) -> dict[str, Any]:
    con = open_db()
    try:
        row = con.execute(
            """
            SELECT c.legacy_card_id AS card_id, c.parent_id AS node_id, c.title AS front, c.content_md AS back, c.hint,
                   n.title AS node_title, n.item_type AS node_role, n.content_md AS answer_md,
                   f.due_at
            FROM study_knowledge_item c
            JOIN study_knowledge_item n ON n.id = c.parent_id
            LEFT JOIN study_knowledge_schedule f ON f.item_id = c.id
            WHERE c.legacy_card_id = ? AND c.status = 'active'
            """,
            (card_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"Unknown card: {card_id}")
        card = _row_dict(row) or {}
        return {
            "schema": "rsim.study.card/v1",
            "card": _enrich_card(card),
        }
    finally:
        con.close()


def get_node_detail(node_id: str) -> dict[str, Any]:
    con = open_db()
    try:
        node = get_node(con, node_id)
        card = con.execute(
            """
            SELECT c.id AS card_id, c.title AS front, c.content_md AS back, c.hint, f.due_at
            FROM study_knowledge_item c
            LEFT JOIN study_knowledge_schedule f ON f.item_id = c.id
            WHERE c.parent_id = 'node:' || ? AND c.item_type='card' AND c.status = 'active'
            ORDER BY c.created_at, c.id
            LIMIT 1
            """,
            (node_id,),
        ).fetchone()
        cards = [
            _row_dict(row) or {}
            for row in con.execute(
                """
                SELECT c.id AS card_id, c.title AS front, c.content_md AS back, c.hint, f.due_at
                FROM study_knowledge_item c
                LEFT JOIN study_knowledge_schedule f ON f.item_id = c.id
                WHERE c.parent_id = 'node:' || ? AND c.item_type='card' AND c.status = 'active'
                ORDER BY c.created_at, c.id
                """,
                (node_id,),
            ).fetchall()
        ]
        children = [
            _row_dict(row) or {}
            for row in con.execute(
                """
                SELECT legacy_node_id AS id, title, item_type AS role, item_type AS kind, sort_order
                FROM study_knowledge_item
                WHERE parent_id = 'node:' || ? AND item_type <> 'card' AND status='active'
                ORDER BY sort_order, title, id
                """,
                (node_id,),
            ).fetchall()
        ]
        return {
            "schema": "rsim.study.node/v1",
            "node": node,
            "card": _enrich_card(_row_dict(card)),
            "cards": [_enrich_card(item) or item for item in cards],
            "children": children,
        }
    finally:
        con.close()


def next_review_card(
    *,
    view: str = "v_study_due_cards",
    scope_id: str | None = None,
) -> dict[str, Any]:
    con = open_db()
    try:
        card = _enrich_card(_next_from_view(con, view=view, scope_id=scope_id))
        due_total = len(list_due_cards(con, scope_id=scope_id, limit=500))
        return {
            "schema": "rsim.study.review-next/v1",
            "view": view,
            "scope_id": scope_id,
            "due_total": due_total,
            "card": card,
        }
    finally:
        con.close()


def grade_review_card(
    *,
    card_id: str,
    rating: int,
    elapsed_ms: int | None = None,
    view: str = "v_study_due_cards",
    scope_id: str | None = None,
) -> dict[str, Any]:
    con = open_db()
    try:
        graded = grade_card(con, card_id=card_id, rating=rating, elapsed_ms=elapsed_ms)
        con.commit()
        nxt = _next_from_view(con, view=view, scope_id=scope_id)
        due_total = len(list_due_cards(con, scope_id=scope_id, limit=500))
        return {
            "schema": "rsim.study.review-grade/v1",
            "graded": graded,
            "next": {
                "view": view,
                "scope_id": scope_id,
                "due_total": due_total,
                "card": _enrich_card(nxt),
            },
        }
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
