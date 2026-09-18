#!/usr/bin/env python3
"""One-time migration of study_* tables from 3dStudio ops.sqlite."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

TABLES = (
    "study_node",
    "study_scope",
    "study_card",
    "study_card_fsrs",
    "study_review_log",
)


def copy_table(source: sqlite3.Connection, target: sqlite3.Connection, table: str) -> int:
    rows = source.execute(f'SELECT * FROM "{table}"').fetchall()
    if not rows:
        return 0
    columns = [description[0] for description in source.execute(f'SELECT * FROM "{table}" LIMIT 1').description]
    placeholders = ", ".join("?" for _ in columns)
    column_list = ", ".join(f'"{name}"' for name in columns)
    target.executemany(
        f'INSERT OR REPLACE INTO "{table}" ({column_list}) VALUES ({placeholders})',
        [tuple(row[col] for col in columns) for row in rows],
    )
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(r"D:\Rsim_helper\basic_model\apps\3dStudio\ops.sqlite"),
    )
    parser.add_argument("--target", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "study.sqlite")
    args = parser.parse_args(argv)

    if not args.source.exists():
        print(f"source not found: {args.source}", file=sys.stderr)
        return 1

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from db import connect, ensure_schema  # noqa: WPS433

    args.target.parent.mkdir(parents=True, exist_ok=True)
    if not args.target.exists():
        connect(args.target)

    source = sqlite3.connect(args.source)
    source.row_factory = sqlite3.Row
    target = connect(args.target)
    try:
        ensure_schema(target)
        counts = {table: copy_table(source, target, table) for table in TABLES}
        target.commit()
    finally:
        source.close()
        target.close()

    print({table: counts[table] for table in TABLES})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
