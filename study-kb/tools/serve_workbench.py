#!/usr/bin/env python3
"""Launch 3dworkbench UI against study-kb SQLite (not ops.sqlite)."""

from __future__ import annotations

import argparse
import os
import sys
import types
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STUDIO_ROOT = REPO_ROOT / "3dStudio"
STUDIO_TOOLS = STUDIO_ROOT / "tools"
STUDY_TOOLS = Path(__file__).resolve().parent
STUDY_WEB = Path(__file__).resolve().parents[1] / "web"
STUDY_DB = Path(__file__).resolve().parents[1] / "data" / "study.sqlite"


def _install_db_shim() -> None:
    sys.path.insert(0, str(STUDY_TOOLS))
    import db as study_db  # noqa: WPS433

    study_db.connect(STUDY_DB)

    shim = types.ModuleType("db")
    shim.DB_PATH = STUDY_DB
    shim.DELETED_MANAGED_VIEWS_KEY = study_db.DELETED_MANAGED_VIEWS_KEY
    shim.connect = lambda db_path=None, *, migrate=True: study_db.connect(  # noqa: E731
        db_path or STUDY_DB,
        migrate=migrate,
    )
    shim.ensure_schema = study_db.ensure_schema
    shim.init_db = study_db.init_db
    sys.modules["db"] = shim
    sys.path.insert(0, str(STUDIO_TOOLS))


def _install_workbench_study_shim() -> None:
    from workbench_study_shim import install  # noqa: WPS433

    install()


def _free_port(port: int) -> None:
    if os.name != "nt":
        return
    import subprocess

    result = subprocess.run(
        ["netstat", "-ano"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        check=False,
    )
    suffix = f":{port}"
    for line in result.stdout.splitlines():
        if "LISTENING" not in line or suffix not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        pid = parts[-1]
        if pid.isdigit() and int(pid) not in {0, os.getpid()}:
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                capture_output=True,
                check=False,
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open study-kb in 3dworkbench UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8033)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)

    if not STUDIO_ROOT.exists():
        print(f"未找到 3dStudio 软链接: {STUDIO_ROOT}", file=sys.stderr)
        return 1
    if not STUDY_DB.exists():
        print(f"未找到学习库: {STUDY_DB}", file=sys.stderr)
        return 1
    if not STUDY_WEB.is_dir():
        print(f"未找到学习库前端: {STUDY_WEB}", file=sys.stderr)
        return 1

    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    _install_db_shim()
    _install_workbench_study_shim()

    from study_workbench_patch import install as install_study_workbench_patch  # noqa: WPS433

    install_study_workbench_patch()

    import workbench_api  # noqa: WPS433
    import workbench_server  # noqa: WPS433

    workbench_server.metrics = workbench_api.metrics
    workbench_server.metric_definitions = workbench_api.metric_definitions
    workbench_server.dashboard_preferences = workbench_api.dashboard_preferences
    workbench_server.command_catalog = workbench_api.command_catalog
    serve = workbench_server.serve

    _free_port(args.port)

    url = f"http://{args.host}:{args.port}"
    if not args.no_open:
        webbrowser.open(url)
    print(f"学习库 3dworkbench: {url}")
    print("推荐视图: v_study_due_cards, v_study_node_cards, v_study_scope_tree")
    serve(args.host, args.port, web_root=STUDY_WEB)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
