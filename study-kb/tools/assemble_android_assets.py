#!/usr/bin/env python3
"""Assemble a git-free study runtime into the Android asset tree.

The output keeps the study-kb / 3dStudio layout that serve_workbench.py
already expects. The phone copy of study.sqlite is a consistent snapshot;
it is not the live Windows database.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STUDIO_ROOT = Path(os.environ.get("STUDY_STUDIO_ROOT", REPO_ROOT / "3dStudio")).resolve()
CONTRACT_V2 = os.environ.get("STUDY_CONTRACT_V2") == "1"
STUDY_ROOT = REPO_ROOT / "study-kb"
DEST_ROOT = STUDY_ROOT / "android" / "app" / "src" / "main" / "assets" / "runtime"

STUDIO_TOOLS = (
    "workbench_server.py",
    "workbench_api.py",
    "plugin_host.py",
    "plugin_workspace.py",
    "record_contract.py",
    "qr_service.py",
    "orders.py",
    "codes.py",
    "view_writeback.py",
)
STUDIO_PYTHON = (
    "tree_model.py",
    "workbench_plugins.py",
)
SKIP_TOOL_NAMES = {
    "assemble_android_assets.py",
    "knowledge_migration.py",
    "migrate_from_studio.py",
    "serve_ui.py",
}
SQLITE_REL = "study-kb/data/study.sqlite"


def _posix(path: Path) -> str:
    return path.as_posix()


def _reject_git(rel: str) -> None:
    parts = Path(rel).parts
    if ".git" in parts or any(part.startswith(".git") for part in parts):
        raise RuntimeError(f"refusing to package git path: {rel}")


def _copy_bytes(dest: Path, payload: bytes) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def _copy_file(src: Path, rel: str, copied: dict[str, str]) -> None:
    rel = _posix(Path(rel))
    _reject_git(rel)
    if not src.is_file():
        raise FileNotFoundError(src)
    copied[rel] = _copy_bytes(DEST_ROOT / rel, src.read_bytes())


def _copy_tree(src_root: Path, dest_rel: str, copied: dict[str, str]) -> None:
    if not src_root.is_dir():
        raise FileNotFoundError(src_root)
    for src in sorted(path for path in src_root.rglob("*") if path.is_file()):
        if "__pycache__" in src.parts or src.suffix == ".pyc":
            continue
        rel = _posix(Path(dest_rel) / src.relative_to(src_root))
        _copy_file(src, rel, copied)


def _include_tool(path: Path) -> bool:
    name = path.name
    if path.suffix != ".py" or not path.is_file():
        return False
    if name.startswith("_tmp") or name in SKIP_TOOL_NAMES:
        return False
    return True


def _copy_database(src: Path, copied: dict[str, str]) -> None:
    if not src.is_file():
        raise FileNotFoundError(src)
    dest = DEST_ROOT / SQLITE_REL
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    source = sqlite3.connect(src.as_uri() + "?mode=ro", uri=True)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    copied[SQLITE_REL] = hashlib.sha256(dest.read_bytes()).hexdigest()


def assemble() -> Path:
    # Validate before touching the generated destination; never accidentally package main.
    if CONTRACT_V2:
        for rel in ("3dworkbench/python/command_gateway.py", "3dworkbench/contracts/data-binding.schema.json"):
            if not (STUDIO_ROOT / rel).is_file():
                raise RuntimeError(f"contract-v2 source missing: {rel}")
        branch = subprocess.check_output(
            ["git", "-C", str(STUDIO_ROOT), "branch", "--show-current"], text=True).strip()
        if branch != "feat/workbench-contract-v2":
            raise RuntimeError(f"refusing non-contract branch: {branch}")
    if DEST_ROOT.exists():
        shutil.rmtree(DEST_ROOT)
    DEST_ROOT.mkdir(parents=True)
    copied: dict[str, str] = {}

    tools = STUDY_ROOT / "tools"
    for src in sorted(tools.glob("*.py")):
        if _include_tool(src):
            _copy_file(src, f"study-kb/tools/{src.name}", copied)
    _copy_tree(STUDY_ROOT / "web", "study-kb/web", copied)
    _copy_tree(STUDY_ROOT / "plugins", "study-kb/plugins", copied)
    _copy_tree(STUDY_ROOT / "schema", "study-kb/schema", copied)
    _copy_database(STUDY_ROOT / "data" / "study.sqlite", copied)

    for name in STUDIO_TOOLS:
        _copy_file(STUDIO_ROOT / "tools" / name, f"3dStudio/tools/{name}", copied)
    for name in STUDIO_PYTHON:
        _copy_file(
            STUDIO_ROOT / "3dworkbench" / "python" / name,
            f"3dStudio/3dworkbench/python/{name}",
            copied,
        )
    if CONTRACT_V2:
        _copy_tree(STUDIO_ROOT / "3dworkbench/python", "3dStudio/3dworkbench/python", copied)
        _copy_tree(STUDIO_ROOT / "3dworkbench/contracts", "3dStudio/3dworkbench/contracts", copied)
        _copy_tree(STUDIO_ROOT / "3dworkbench/docs", "3dStudio/3dworkbench/docs", copied)
        for name in ("requirements-contracts.txt", "requirements-contracts-lock.txt"):
            _copy_file(STUDIO_ROOT / "3dworkbench" / name, f"3dStudio/3dworkbench/{name}", copied)
        for rel in ("tests/test_data_platform_v2.py", "tests/test_data_schema_parity.py",
                    "tests/contracts/schema-fixtures.json", "tests/contracts/schema-parity.mjs",
                    "tests/contracts/package.json", "tests/contracts/package-lock.json"):
            _copy_file(STUDIO_ROOT / rel, "3dStudio/" + rel, copied)
        plan_root = os.environ.get("STUDY_CONTRACT_PLAN_ROOT")
        if plan_root:
            plan = Path(plan_root).resolve()
            _copy_file(plan, "contract-v2-docs/plan.md", copied)
            for name in ("protocol.md", "acceptance.md", "data-bindings.md", "foundation-progress.md"):
                _copy_file(plan.with_suffix("") / name, "contract-v2-docs/" + name, copied)
        metadata = {"profile": "contract-v2", "studioBranch": branch,
                    "studioCommit": subprocess.check_output(
                        ["git", "-C", str(STUDIO_ROOT), "rev-parse", "HEAD"], text=True).strip(),
                    "studioChanges": subprocess.check_output(
                        ["git", "-C", str(STUDIO_ROOT), "status", "--porcelain"], text=True),
                    "sourceRoot": str(STUDIO_ROOT), "liveDatabaseIntegration": False,
                    "androidValidator": "jsonschema==4.17.3 (Draft 2020-12)",
                    "testPort": 18033}
        payload = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        copied["contract-v2-build.json"] = _copy_bytes(DEST_ROOT / "contract-v2-build.json", payload)
    _copy_tree(STUDIO_ROOT / "3dworkbench" / "web", "3dStudio/3dworkbench/web", copied)
    # Study discovers every platform plugin (sqlite-triggers, table-print).
    _copy_tree(STUDIO_ROOT / "3dworkbench" / "plugins" / "official", "3dStudio/3dworkbench/plugins/official", copied)

    required = (
        "study-kb/tools/serve_workbench.py",
        "study-kb/web/index.html",
        "study-kb/web/vendor/marked.esm.js",
        "study-kb/web/vendor/purify.es.mjs",
        "3dStudio/tools/workbench_server.py",
        "3dStudio/3dworkbench/python/tree_model.py",
        "3dStudio/3dworkbench/python/workbench_plugins.py",
        "3dStudio/3dworkbench/web/workbench.css",
        "3dStudio/3dworkbench/web/pluginWorkspace.mjs",
        "3dStudio/3dworkbench/web/components/tableGrid.mjs",
        "3dStudio/3dworkbench/plugins/official/table-print/plugin.json",
        SQLITE_REL,
    )
    missing = [item for item in required if item not in copied]
    if missing:
        raise RuntimeError("runtime is missing required files: " + ", ".join(missing))
    if any(".git" in Path(rel).parts for rel in copied):
        raise RuntimeError("runtime contains a git path")

    manifest = "\n".join(sorted(copied)) + "\n"
    (DEST_ROOT / "runtime-manifest.txt").write_text(manifest, encoding="utf-8", newline="\n")
    stamp_hasher = hashlib.sha256()
    for rel in sorted(copied):
        stamp_hasher.update(rel.encode("utf-8"))
        stamp_hasher.update(b"\0")
        stamp_hasher.update(copied[rel].encode("ascii"))
        stamp_hasher.update(b"\n")
    (DEST_ROOT / "runtime-stamp.txt").write_text(stamp_hasher.hexdigest() + "\n", encoding="utf-8", newline="\n")
    return DEST_ROOT


def main() -> int:
    dest = assemble()
    count = sum(1 for path in dest.rglob("*") if path.is_file())
    print(f"已组装 {count} 个文件到 {dest}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"组装失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
