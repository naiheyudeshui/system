#!/usr/bin/env python3
"""Import Agent Markdown outline into study_node + study_scope."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from _paths import DEFAULT_DB, STUDY_KB_TOOLS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import study outline Markdown")
    parser.add_argument("--book", help="Optional book title override")
    parser.add_argument("--markdown", type=Path, help="Markdown outline file")
    parser.add_argument("--text", help="Inline markdown outline")
    parser.add_argument("--source-ref", default="", help="Source document reference")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path")
    parser.add_argument("--record", type=Path, help="Write import audit JSON")
    args = parser.parse_args(argv)

    if bool(args.markdown) == bool(args.text):
        parser.error("provide exactly one of --markdown or --text")

    markdown = args.text if args.text is not None else args.markdown.read_text(encoding="utf-8")

    sys.path.insert(0, str(STUDY_KB_TOOLS))
    import study_kb  # noqa: WPS433

    con = study_kb.open_db(args.db)
    try:
        result = study_kb.import_outline_markdown(
            con,
            markdown=markdown,
            book_title=args.book,
            source_ref=args.source_ref,
        )
        con.commit()
    finally:
        con.close()

    payload = {
        "id": "study-import-md.latest",
        "schema": "rsim.readme.study-import-md/v1",
        "book_title": result["book"]["title"],
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
