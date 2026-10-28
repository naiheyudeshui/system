"""Serve Study on a copy of the learning database for browser checks.

    py -3 study-kb/tests/browser_server.py --port 8099

The copy keeps the real tables and data, but its BSP layout is reset so the
workspace starts from Study's default tree (table catalog | table grid).  The
real database and the 8033 service are never touched.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / "study-kb" / "tools"))
    work = Path(tempfile.mkdtemp(prefix="study-browser-"))
    copy = work / "study.sqlite"
    source = sqlite3.connect(ROOT / "study-kb" / "data" / "study.sqlite")
    target = sqlite3.connect(copy)
    source.backup(target)
    source.close()
    target.execute("DELETE FROM workbench_plugin_layout") if target.execute("SELECT 1 FROM sqlite_master WHERE name='workbench_plugin_layout'").fetchone() else None
    target.commit()
    target.close()

    import db
    db.DB_PATH = copy
    import serve_workbench
    serve_workbench.STUDY_DB = copy
    serve_workbench._install_db_shim()
    serve_workbench._install_workbench_study_shim()
    import study_workbench_patch
    study_workbench_patch.install()
    import workbench_server
    server = workbench_server.WorkbenchHTTPServer(("127.0.0.1", args.port), workbench_server.make_handler(ROOT / "study-kb" / "web"))
    print(f"Study browser-check server on http://127.0.0.1:{args.port} ({copy})", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
