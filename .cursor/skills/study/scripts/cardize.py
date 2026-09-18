#!/usr/bin/env python3
"""Import flashcard drafts into study_card for a node."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from _paths import DEFAULT_DB, STUDY_KB_TOOLS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import study cards JSON")
    parser.add_argument("--node", required=True, help="study_node id")
    parser.add_argument("--input", required=True, type=Path, help="Cards JSON file")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    cards = json.loads(args.input.read_text(encoding="utf-8"))
    if isinstance(cards, dict):
        cards = cards.get("cards", [])

    if args.dry_run:
        print(json.dumps({"node_id": args.node, "count": len(cards), "cards": cards}, ensure_ascii=False, indent=2))
        return 0

    sys.path.insert(0, str(STUDY_KB_TOOLS))
    import study_kb  # noqa: WPS433

    con = study_kb.open_db(args.db)
    created: list[dict] = []
    try:
        if len(cards) == 1:
            item = cards[0]
            front = str(item["front"])
            back = str(item["back"])
            con.execute(
                """
                UPDATE study_node
                SET role = 'topic', answer_md = ?, updated_at = datetime('now', 'localtime')
                WHERE id = ?
                """,
                (back, args.node),
            )
            synced = study_kb.sync_topic_card(con, args.node)
            created.append(synced)
        else:
            for item in cards:
                created.append(
                    study_kb.create_card(
                        con,
                        node_id=args.node,
                        front=str(item["front"]),
                        back=str(item["back"]),
                        hint=str(item.get("hint", "")),
                        card_type=str(item.get("card_type", "basic")),
                        source_ref=str(item.get("source_ref", "")),
                    )
                )
        con.commit()
    finally:
        con.close()

    print(json.dumps({"node_id": args.node, "created": len(created), "cards": created}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
