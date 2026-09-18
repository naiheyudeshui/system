#!/usr/bin/env python3
"""CLI for study knowledge base review sessions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from study_kb import grade_card, list_due_cards, open_db


def cmd_due(args: argparse.Namespace) -> int:
    con = open_db(Path(args.db) if args.db else None)
    try:
        cards = list_due_cards(con, scope_id=args.scope, limit=args.limit)
        if args.json:
            print(json.dumps(cards, ensure_ascii=False, indent=2))
        else:
            for item in cards:
                print(f"{item['card_id']}\t{item.get('node_title', '')}\t{item['front']}")
        return 0
    finally:
        con.close()


def cmd_grade(args: argparse.Namespace) -> int:
    con = open_db(Path(args.db) if args.db else None)
    try:
        result = grade_card(
            con,
            card_id=args.card_id,
            rating=args.rating,
            elapsed_ms=args.elapsed_ms,
        )
        con.commit()
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(f"graded {args.card_id} -> due_at={result['due_at']}")
        return 0
    finally:
        con.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Study knowledge base review CLI")
    parser.add_argument("--db", help="SQLite database path (default: study-kb/data/study.sqlite)")
    sub = parser.add_subparsers(dest="command", required=True)

    due = sub.add_parser("due", help="List due cards")
    due.add_argument("--scope", help="Filter by study_scope id")
    due.add_argument("--limit", type=int, default=20)
    due.add_argument("--json", action="store_true")
    due.set_defaults(func=cmd_due)

    grade = sub.add_parser("grade", help="Grade a card (rating 1-4)")
    grade.add_argument("card_id")
    grade.add_argument("rating", type=int, choices=[1, 2, 3, 4])
    grade.add_argument("--elapsed-ms", type=int)
    grade.add_argument("--json", action="store_true")
    grade.set_defaults(func=cmd_grade)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
