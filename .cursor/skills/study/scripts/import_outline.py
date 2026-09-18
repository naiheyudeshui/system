#!/usr/bin/env python3
"""Import a book outline into study_node + default study_scope."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from _paths import DEFAULT_DB, IMPORTS_DIR, STUDY_KB_TOOLS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import study outline JSON")
    parser.add_argument("--book", required=True, help="Book title")
    parser.add_argument("--outline", required=True, type=Path, help="Outline JSON file")
    parser.add_argument("--source-ref", default="", help="Source document reference")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path")
    parser.add_argument("--record", type=Path, help="Write import audit JSON")
    args = parser.parse_args(argv)

    sys.path.insert(0, str(STUDY_KB_TOOLS))
    import study_kb  # noqa: WPS433

    outline = json.loads(args.outline.read_text(encoding="utf-8"))
    chapters = outline.get("chapters", outline if isinstance(outline, list) else [])

    con = study_kb.open_db(args.db)
    try:
        result = study_kb.import_outline(
            con,
            book_title=args.book,
            chapters=chapters,
            source_ref=args.source_ref,
        )
        con.commit()
    finally:
        con.close()

    payload = {
        "id": "study-import.latest",
        "schema": "rsim.readme.study-import/v1",
        "book_title": args.book,
        "source_ref": args.source_ref,
        "scope_id": result["scope"]["id"],
        "book_node_id": result["book"]["id"],
        "node_count": len(result["nodes"]),
        "imported_at": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    if args.record:
        args.record.parent.mkdir(parents=True, exist_ok=True)
        args.record.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
