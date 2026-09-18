#!/usr/bin/env python3
"""Read-only SQL browser for study-kb (Datasette, port 8022).

主界面请用 serve_workbench.py（3dworkbench 四区，端口 8033）。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "study.sqlite"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open study-kb in Datasette browser UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8022)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)

    if not DB_PATH.exists():
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from db import connect  # noqa: WPS433

        connect(DB_PATH)

    try:
        import datasette  # noqa: F401
    except ImportError:
        print("请先安装: pip install datasette", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{args.port}"
    if not args.no_open:
        webbrowser.open(url)

    cmd = [
        sys.executable,
        "-m",
        "datasette",
        "serve",
        str(DB_PATH),
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    print(f"学习库浏览器: {url}")
    print("推荐表/视图: v_study_due_cards, v_study_node_cards, v_study_scope_tree")
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
