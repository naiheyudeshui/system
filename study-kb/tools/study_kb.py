"""Study knowledge base helpers for system study-kb SQLite."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from study_fsrs import FsrsState, new_card_state, review

from db import connect


def new_id(prefix: str = "") -> str:
    value = uuid.uuid4().hex[:26]
    return f"{prefix}{value}" if prefix else value


def _row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def create_node(
    con: sqlite3.Connection,
    *,
    title: str,
    kind: str,
    parent_id: str | None = None,
    source_ref: str = "",
    sort_order: int = 0,
    metadata: dict[str, Any] | None = None,
    node_id: str | None = None,
    role: str = "outline",
    answer_md: str = "",
) -> dict[str, Any]:
    if role not in {"outline", "topic"}:
        raise ValueError("role must be outline or topic")
    node_id = node_id or new_id("node_")
    con.execute(
        """
        INSERT INTO study_node (
          id, parent_id, kind, title, source_ref, sort_order, metadata_json, role, answer_md
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            parent_id,
            kind,
            title,
            source_ref,
            sort_order,
            json.dumps(metadata or {}, ensure_ascii=False),
            role,
            answer_md or "",
        ),
    )
    row = con.execute("SELECT * FROM study_node WHERE id = ?", (node_id,)).fetchone()
    node = _row_dict(row) or {}
    if role == "topic":
        sync_topic_card(con, node_id)
        row = con.execute("SELECT * FROM study_node WHERE id = ?", (node_id,)).fetchone()
        node = _row_dict(row) or node
    return node


def get_node(con: sqlite3.Connection, node_id: str) -> dict[str, Any]:
    row = con.execute("SELECT * FROM study_node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown node: {node_id}")
    return _row_dict(row) or {}


def sync_topic_card(con: sqlite3.Connection, node_id: str) -> dict[str, Any]:
    """Ensure a topic node has exactly one active study_card for FSRS."""
    node = get_node(con, node_id)
    if node.get("role") != "topic":
        raise ValueError("sync_topic_card requires role=topic")

    front = str(node.get("title") or "").strip()
    back = str(node.get("answer_md") or "").strip()
    if not front:
        raise ValueError("topic node title is required")

    existing = con.execute(
        """
        SELECT id FROM study_card
        WHERE node_id = ? AND status = 'active'
        ORDER BY created_at, id
        LIMIT 1
        """,
        (node_id,),
    ).fetchone()

    if existing:
        con.execute(
            """
            UPDATE study_card
            SET front = ?, back = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
            """,
            (front, back, existing["id"]),
        )
        card_id = existing["id"]
    else:
        card = create_card(con, node_id=node_id, front=front, back=back)
        card_id = card["id"]

    row = con.execute(
        """
        SELECT c.*, f.due_at, f.stability, f.difficulty, f.reps, f.lapses
        FROM study_card c
        JOIN study_card_fsrs f ON f.card_id = c.id
        WHERE c.id = ?
        """,
        (card_id,),
    ).fetchone()
    return _row_dict(row) or {}


def _import_node_tree(
    con: sqlite3.Connection,
    items: list[dict[str, Any]],
    *,
    parent_id: str | None,
) -> list[dict[str, Any]]:
    created: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        role = str(item.get("role") or "outline")
        answer_md = str(item.get("answer_md") or "")
        if answer_md and role == "outline":
            role = "topic"
        node = create_node(
            con,
            title=str(item.get("title", f"Node {index + 1}")),
            kind=str(item.get("kind", "section")),
            parent_id=parent_id,
            source_ref=str(item.get("source_ref", "")),
            sort_order=int(item.get("sort_order", index)),
            role=role,
            answer_md=answer_md,
        )
        created.append(node)
        children = item.get("children") or item.get("sections") or item.get("topics") or []
        if isinstance(children, list) and children:
            created.extend(_import_node_tree(con, children, parent_id=node["id"]))
    return created


def create_scope(
    con: sqlite3.Connection,
    *,
    anchor_node_id: str,
    label: str,
    is_default: bool = False,
    scope_id: str | None = None,
) -> dict[str, Any]:
    scope_id = scope_id or new_id("scope_")
    if is_default:
        con.execute("UPDATE study_scope SET is_default = 0")
    con.execute(
        """
        INSERT INTO study_scope (id, anchor_node_id, label, is_default)
        VALUES (?, ?, ?, ?)
        """,
        (scope_id, anchor_node_id, label, 1 if is_default else 0),
    )
    row = con.execute("SELECT * FROM study_scope WHERE id = ?", (scope_id,)).fetchone()
    return _row_dict(row) or {}


def create_card(
    con: sqlite3.Connection,
    *,
    node_id: str,
    front: str,
    back: str,
    hint: str = "",
    card_type: str = "basic",
    source_ref: str = "",
    card_id: str | None = None,
    due_at: str | None = None,
) -> dict[str, Any]:
    card_id = card_id or new_id("card_")
    con.execute(
        """
        INSERT INTO study_card (id, node_id, front, back, hint, card_type, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (card_id, node_id, front, back, hint, card_type, source_ref),
    )
    fsrs = new_card_state(due_at=due_at)
    con.execute(
        """
        INSERT INTO study_card_fsrs
          (card_id, due_at, stability, difficulty, reps, lapses, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            card_id,
            fsrs.due_at,
            fsrs.stability,
            fsrs.difficulty,
            fsrs.reps,
            fsrs.lapses,
            fsrs.to_json(),
        ),
    )
    row = con.execute(
        """
        SELECT c.*, f.due_at, f.stability, f.difficulty, f.reps, f.lapses
        FROM study_card c
        JOIN study_card_fsrs f ON f.card_id = c.id
        WHERE c.id = ?
        """,
        (card_id,),
    ).fetchone()
    return _row_dict(row) or {}


def list_due_cards(
    con: sqlite3.Connection,
    *,
    scope_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    if scope_id:
        rows = con.execute(
            """
            SELECT d.*
            FROM v_study_due_cards d
            JOIN v_study_scope_tree t ON t.node_id = d.node_id
            WHERE t.scope_id = ?
            ORDER BY d.due_at, d.card_id
            LIMIT ?
            """,
            (scope_id, limit),
        ).fetchall()
    else:
        rows = con.execute(
            """
            SELECT * FROM v_study_due_cards
            ORDER BY due_at, card_id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_row_dict(row) or {} for row in rows]


def grade_card(
    con: sqlite3.Connection,
    *,
    card_id: str,
    rating: int,
    elapsed_ms: int | None = None,
) -> dict[str, Any]:
    row = con.execute(
        """
        SELECT card_id, due_at, stability, difficulty, reps, lapses, state_json
        FROM study_card_fsrs
        WHERE card_id = ?
        """,
        (card_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Unknown card: {card_id}")

    before = FsrsState.from_json(row["state_json"])
    before.stability = float(row["stability"])
    before.difficulty = float(row["difficulty"])
    before.reps = int(row["reps"])
    before.lapses = int(row["lapses"])
    before.due_at = row["due_at"]

    after = review(before, rating)
    con.execute(
        """
        UPDATE study_card_fsrs
        SET due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?,
            state_json = ?, updated_at = datetime('now', 'localtime')
        WHERE card_id = ?
        """,
        (
            after.due_at,
            after.stability,
            after.difficulty,
            after.reps,
            after.lapses,
            after.to_json(),
            card_id,
        ),
    )
    log_id = new_id("rev_")
    con.execute(
        """
        INSERT INTO study_review_log
          (id, card_id, rating, elapsed_ms, before_state_json, after_state_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            log_id,
            card_id,
            rating,
            elapsed_ms,
            before.to_json(),
            after.to_json(),
        ),
    )
    updated = con.execute(
        """
        SELECT c.*, f.due_at, f.stability, f.difficulty, f.reps, f.lapses
        FROM study_card c
        JOIN study_card_fsrs f ON f.card_id = c.id
        WHERE c.id = ?
        """,
        (card_id,),
    ).fetchone()
    return _row_dict(updated) or {}


def import_outline(
    con: sqlite3.Connection,
    *,
    book_title: str,
    chapters: list[dict[str, Any]],
    source_ref: str = "",
) -> dict[str, Any]:
    book = create_node(
        con,
        title=book_title,
        kind="book",
        source_ref=source_ref,
        role="outline",
    )
    created_nodes: list[dict[str, Any]] = [book]
    created_nodes.extend(_import_node_tree(con, chapters, parent_id=book["id"]))
    scope = create_scope(
        con,
        anchor_node_id=book["id"],
        label=book_title,
        is_default=True,
    )
    return {"book": book, "scope": scope, "nodes": created_nodes}


def import_outline_markdown(
    con: sqlite3.Connection,
    *,
    markdown: str,
    book_title: str | None = None,
    source_ref: str = "",
) -> dict[str, Any]:
    from study_outline_md import parse_outline_markdown, parsed_to_import_dict

    roots = parse_outline_markdown(markdown)
    if not roots:
        raise ValueError("markdown outline is empty")

    if len(roots) == 1:
        root = roots[0]
        book = create_node(
            con,
            title=book_title or root.title,
            kind=root.kind,
            source_ref=source_ref or root.source_ref,
            role=root.role,
            answer_md=root.answer_md,
        )
        created = [book, *_import_node_tree(con, parsed_to_import_dict(root.children), parent_id=book["id"])]
    else:
        book = create_node(
            con,
            title=book_title or "Imported Outline",
            kind="book",
            source_ref=source_ref,
            role="outline",
        )
        created = [book, *_import_node_tree(con, parsed_to_import_dict(roots), parent_id=book["id"])]

    scope = create_scope(con, anchor_node_id=book["id"], label=book["title"], is_default=False)
    return {"book": book, "scope": scope, "nodes": created}


def build_markmap_markdown(
    con: sqlite3.Connection,
    *,
    scope_id: str | None = None,
    root_id: str | None = None,
) -> str:
    """Build heading-only markdown for markmap from study_node tree."""

    def children_of(parent_id: str) -> list[sqlite3.Row]:
        return con.execute(
            """
            SELECT id, title, role
            FROM study_node
            WHERE parent_id = ?
            ORDER BY sort_order, title, id
            """,
            (parent_id,),
        ).fetchall()

    lines: list[str] = []

    def heading_prefix(depth: int) -> str:
        return "#" * max(1, min(6, depth))

    def append_node(row: sqlite3.Row, depth: int) -> None:
        role_tag = "topic" if row["role"] == "topic" else "outline"
        lines.append(f"{heading_prefix(depth)} {row['title']} <!-- node:{row['id']} {role_tag} -->")

    def append_card_leaves(node_id: str, depth: int) -> None:
        cards = con.execute(
            """
            SELECT id, front
            FROM study_card
            WHERE node_id = ? AND status = 'active'
            ORDER BY created_at, id
            """,
            (node_id,),
        ).fetchall()
        prefix = heading_prefix(depth + 1)
        for card in cards:
            title = str(card["front"] or "卡片").strip().splitlines()[0][:160]
            lines.append(f"{prefix} {title} <!-- node:{node_id} card:{card['id']} topic -->")

    def walk(parent_id: str, depth: int) -> None:
        for child in children_of(parent_id):
            append_node(child, depth)
            child_rows = children_of(child["id"])
            if child_rows:
                walk(child["id"], depth + 1)
            elif child["role"] == "topic":
                append_card_leaves(child["id"], depth)

    if scope_id:
        anchor = con.execute(
            "SELECT anchor_node_id FROM study_scope WHERE id = ?",
            (scope_id,),
        ).fetchone()
        if not anchor:
            return ""
        root = con.execute(
            "SELECT id, title, role FROM study_node WHERE id = ?",
            (anchor["anchor_node_id"],),
        ).fetchone()
        if not root:
            return ""
        append_node(root, 1)
        walk(root["id"], 2)
    elif root_id:
        root = con.execute(
            "SELECT id, title, role FROM study_node WHERE id = ?",
            (root_id,),
        ).fetchone()
        if not root:
            return ""
        append_node(root, 1)
        walk(root["id"], 2)
    else:
        roots = con.execute(
            """
            SELECT id, title, role
            FROM study_node
            WHERE parent_id IS NULL
            ORDER BY sort_order, title, id
            """
        ).fetchall()
        for root in roots:
            append_node(root, 1)
            walk(root["id"], 2)

    return "\n".join(lines) + ("\n" if lines else "")


def open_db(db_path: Path | None = None) -> sqlite3.Connection:
    return connect(db_path)
