#!/usr/bin/env python3
"""Probe and call the live study-kb workbench server (phone-first primary store)."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from pathlib import Path
from urllib import error, request

from _paths import BACKUP_DIR, DEFAULT_SERVER_URL, REPO_ROOT

_TIMEOUT = 15
# Agent 终端常设 HTTP_PROXY=127.0.0.1:7888，但 NO_PROXY 不含局域网；直连手机 8033 必须绕过代理。
_DIRECT_OPENER = request.build_opener(request.ProxyHandler({}))


def _url(base: str, path: str) -> str:
    return base.rstrip("/") + path


def _request(method: str, url: str, payload: dict | None = None, *, timeout: int = _TIMEOUT) -> tuple[int, dict | bytes, dict[str, str]]:
    data = None
    headers: dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with _DIRECT_OPENER.open(req, timeout=timeout) as response:
            body = response.read()
            ctype = response.headers.get("Content-Type", "")
            if "json" in ctype:
                return response.status, json.loads(body.decode("utf-8")), dict(response.headers)
            return response.status, body, dict(response.headers)
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = {"detail": raw or str(exc)}
        return exc.code, detail, {}


def probe_server(base: str) -> dict:
    result: dict = {"server": base, "reachable": False, "readable": False, "writable": False, "schema": {}, "errors": [], "warnings": []}

    status, body, _ = _request("GET", _url(base, "/"))
    if status != 200:
        result["errors"].append(f"GET / 返回 {status}: {body}")
        return result
    result["reachable"] = True

    status, tree, _ = _request("GET", _url(base, "/api/study/tree?model=knowledge"))
    if status != 200:
        result["errors"].append(f"树 API 失败 ({status}): {tree}")
        return result

    rows = tree.get("rows") or []
    result["readable"] = True
    result["schema"]["tree_api"] = "knowledge"
    result["schema"]["editing_provider"] = (tree.get("editing") or {}).get("provider")
    result["schema"]["node_count"] = len(rows)
    result["schema"]["scope_count"] = len(tree.get("scopes") or [])

    sample_id = None
    for row in rows:
        if row.get("node_id"):
            sample_id = row["node_id"]
            break
    if not sample_id:
        result["warnings"].append("树为空，无法探测 knowledge/read")
        return result

    status, read_body, _ = _request("POST", _url(base, "/api/study/knowledge/read"), {"node_id": sample_id})
    if status != 200:
        result["errors"].append(f"knowledge/read 失败 ({status}): {read_body}")
        return result

    status, write_body, _ = _request(
        "POST",
        _url(base, "/api/study/knowledge/save"),
        {
            "node_id": sample_id,
            "version": "probe-stale-version-on-purpose",
            "request_id": f"probe-{uuid.uuid4()}",
            "operation": "content",
            "content_md": read_body.get("node", {}).get("content_md", ""),
        },
    )
    if status == 403:
        result["errors"].append("写接口返回 403：需要服务令牌或未启用 trusted-lan-write")
    elif status == 409:
        result["writable"] = True
    elif status == 400 and isinstance(write_body, dict) and "version" in str(write_body.get("detail", "")).lower():
        result["writable"] = True
    else:
        result["errors"].append(f"写探测未得到预期 409/403 ({status}): {write_body}")

    return result


def read_node(base: str, node_id: str) -> dict:
    status, body, _ = _request("POST", _url(base, "/api/study/knowledge/read"), {"node_id": node_id})
    if status != 200:
        raise ValueError(f"knowledge/read 失败 ({status}): {body}")
    return body


def save_node(base: str, payload: dict) -> dict:
    status, body, _ = _request("POST", _url(base, "/api/study/knowledge/save"), payload)
    if status == 409:
        raise ValueError(f"版本冲突 (409): {body}")
    if status != 200:
        raise ValueError(f"knowledge/save 失败 ({status}): {body}")
    return body


def _export_bytes(base: str) -> bytes:
    status, body, _ = _request("GET", _url(base, "/api/study/library/export"), timeout=120)
    if status != 200 or not isinstance(body, bytes):
        raise ValueError(f"library/export 失败 ({status}): {body}")
    if not body.startswith(b"SQLite format 3\x00"):
        raise ValueError("export 返回的不是 SQLite 文件")
    return body


def _active_item_count(path: Path) -> int | None:
    con = sqlite3.connect(path)
    try:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='study_knowledge_item'"
        ).fetchone():
            return None
        return int(con.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE status='active'").fetchone()[0])
    finally:
        con.close()


def export_backup(base: str, target: Path | None = None) -> dict:
    body = _export_bytes(base)
    folder = target or BACKUP_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = __import__("datetime").datetime.now().strftime("%Y%m%d-%H%M%S")
    path = folder / f"study-server-{stamp}.sqlite"
    path.write_bytes(body)
    local_mirror = REPO_ROOT / "study-kb" / "data" / "study.sqlite"
    return {
        "ok": True,
        "server": base,
        "bytes": len(body),
        "backup_path": str(path),
        "local_mirror": str(local_mirror),
        "active_items": _active_item_count(path),
        "note": "备份已写入 backup_path；用 sync-mirror 可同时更新 local_mirror",
    }


def sync_mirror(base: str, *, skip_probe: bool = False) -> dict:
    if not skip_probe:
        check = probe_server(base)
        if not check["reachable"] or not check["readable"]:
            raise ValueError(f"主库不可读，已中止同步: {check.get('errors') or check}")
    body = _export_bytes(base)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = __import__("datetime").datetime.now().strftime("%Y%m%d-%H%M%S")
    archive = BACKUP_DIR / f"study-server-{stamp}.sqlite"
    archive.write_bytes(body)
    mirror = REPO_ROOT / "study-kb" / "data" / "study.sqlite"
    mirror.parent.mkdir(parents=True, exist_ok=True)
    previous_mirror = None
    if mirror.is_file():
        previous_mirror = BACKUP_DIR / f"study-before-mirror-{stamp}.sqlite"
        previous_mirror.write_bytes(mirror.read_bytes())
    mirror.write_bytes(body)
    return {
        "ok": True,
        "server": base,
        "bytes": len(body),
        "archive_path": str(archive),
        "previous_mirror_backup": str(previous_mirror) if previous_mirror else None,
        "local_mirror": str(mirror),
        "active_items": _active_item_count(mirror),
        "note": "local_mirror 已覆盖；可 git add study-kb/data/study.sqlite 提交",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe or call study-kb HTTP server (phone-first).")
    parser.add_argument("--server", default=os.environ.get("STUDY_SERVER_URL", DEFAULT_SERVER_URL))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("probe", help="检查连通性、读树、写权限与 schema 提示")
    read_cmd = sub.add_parser("read", help="POST /api/study/knowledge/read")
    read_cmd.add_argument("--node", required=True)
    save_cmd = sub.add_parser("save", help="POST /api/study/knowledge/save（JSON 文件为完整请求体）")
    save_cmd.add_argument("--input", type=Path, required=True)
    export_cmd = sub.add_parser("export-backup", help="GET /api/study/library/export 保存到 backups/")
    export_cmd.add_argument("--target", type=Path)
    sync_cmd = sub.add_parser("sync-mirror", help="export 主库并覆盖 study-kb/data/study.sqlite")
    sync_cmd.add_argument("--skip-probe", action="store_true", help="跳过写入前 probe（不推荐）")

    args = parser.parse_args(argv)
    base = args.server.strip()
    if args.command == "probe":
        result = probe_server(base)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["reachable"] and result["readable"] and not result["errors"] else 1
    if args.command == "read":
        print(json.dumps(read_node(base, args.node), ensure_ascii=False, indent=2))
        return 0
    if args.command == "save":
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        print(json.dumps(save_node(base, payload), ensure_ascii=False, indent=2))
        return 0
    if args.command == "export-backup":
        print(json.dumps(export_backup(base, args.target), ensure_ascii=False, indent=2))
        return 0
    if args.command == "sync-mirror":
        print(json.dumps(sync_mirror(base, skip_probe=args.skip_probe), ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
