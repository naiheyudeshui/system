#!/usr/bin/env python3
"""Launch 3dworkbench UI against study-kb SQLite (not ops.sqlite)."""

from __future__ import annotations

import argparse
import os
import socket
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


def _lan_ipv4() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            address = sock.getsockname()[0]
            return address if not address.startswith(("127.", "169.254.")) else None
    except OSError:
        return None


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
    parser.add_argument(
        "--trusted-lan-write",
        action="store_true",
        help="allow LAN clients full write access without authentication",
    )
    args = parser.parse_args(argv)

    if not STUDIO_ROOT.exists():
        print(f"未找到 3dStudio 软链接：{STUDIO_ROOT}", file=sys.stderr)
        return 1
    if not STUDY_DB.exists():
        print(f"未找到学习库：{STUDY_DB}", file=sys.stderr)
        return 1
    if not STUDY_WEB.is_dir():
        print(f"未找到学习库前端：{STUDY_WEB}", file=sys.stderr)
        return 1

    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if args.trusted_lan_write:
        os.environ["STUDY_TRUSTED_LAN_WRITE"] = "1"
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

    url = f"http://127.0.0.1:{args.port}"
    lan_ip = _lan_ipv4() if args.host in {"0.0.0.0", "::"} else None
    lan_url = f"http://{lan_ip}:{args.port}" if lan_ip else None
    if not args.no_open:
        webbrowser.open(url)
    print("正在打开学习库 3dworkbench")
    print()
    print(f"本机访问：{url}")
    print(f"局域网访问：{lan_url or '未检测到可用的局域网 IPv4 地址'}")
    permission = "完整操作（可信局域网模式，无鉴权）" if args.trusted_lan_write else "写操作需要令牌"
    print(f"局域网权限：{permission}")
    print("推荐视图：v_study_due_cards, v_study_node_cards, v_study_scope_tree")
    print()
    print("按 Ctrl+C 停止服务", flush=True)
    serve(args.host, args.port, web_root=STUDY_WEB)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())