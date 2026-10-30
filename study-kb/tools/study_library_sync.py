"""Export and replace the live study SQLite library."""

from __future__ import annotations

import sqlite3
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import db
from study_storage_guard import maintenance

MAX_BYTES = 128 * 1024 * 1024
_LOCK = threading.Lock()
_HEADER = b"SQLite format 3\x00"
_RESTORE_VALIDATORS = []


def register_restore_validator(callback) -> None:
    """Host adapters rebuild their resource indexes on the staged database."""
    if callback not in _RESTORE_VALIDATORS:
        _RESTORE_VALIDATORS.append(callback)


def _validate(connection: sqlite3.Connection) -> None:
    result = connection.execute("PRAGMA quick_check").fetchall()
    if [row[0] for row in result] != ["ok"]:
        raise ValueError("库文件完整性检查未通过，已拒绝替换")
    violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise ValueError(f"库文件存在 {len(violations)} 项外键错误，已拒绝替换")


def export_library() -> tuple[bytes, str]:
    with _LOCK:
        filename = f"study-{_stamp()}.sqlite"
        with tempfile.TemporaryDirectory() as directory:
            target_path = Path(directory) / filename
            source = db.connect()
            try:
                target = sqlite3.connect(target_path)
                try:
                    source.backup(target)
                finally:
                    target.close()
            finally:
                source.close()
            return target_path.read_bytes(), filename


def _prepare_installations(connection: sqlite3.Connection, *, reinstall_plugins: bool) -> None:
    names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # Window leases belong to the old running process, never the restored one.
    if "wb_unit_lease" in names:
        connection.execute("DELETE FROM wb_unit_lease")
    if not reinstall_plugins:
        return
    if "workbench_plugin" in names:
        connection.execute("UPDATE workbench_plugin SET state='disabled'")
    if "workbench_plugin_grant" in names:
        connection.execute("DELETE FROM workbench_plugin_grant")
    if "wb_unit_installation" in names:
        connection.execute("UPDATE wb_unit_installation SET status='disabled'")


def import_library(payload: bytes, *, reinstall_plugins: bool = False) -> dict:
    if not payload:
        raise ValueError("没有收到库文件")
    if len(payload) > MAX_BYTES:
        raise ValueError("库文件超过 128MB")
    if not payload.startswith(_HEADER):
        raise ValueError("文件不是 SQLite 数据库")
    with _LOCK:
        with tempfile.TemporaryDirectory() as directory:
            incoming_path = Path(directory) / "incoming.sqlite"
            incoming_path.write_bytes(payload)
            # Migrate and rebuild indexes away from the live library. An invalid
            # archive or failed adapter must never partially replace live data.
            incoming = sqlite3.connect(incoming_path)
            incoming.row_factory = sqlite3.Row
            incoming.execute("PRAGMA foreign_keys=ON")
            try:
                _validate(incoming)
                found = incoming.execute(
                    """SELECT 1 FROM sqlite_master
                       WHERE type='table' AND name IN ('study_knowledge_item', 'study_card')"""
                ).fetchone()
                if not found:
                    raise ValueError("文件里没有学习卡片表，已拒绝替换")
                db.ensure_schema(incoming)
                if not incoming.in_transaction:
                    incoming.execute("BEGIN IMMEDIATE")
                _prepare_installations(incoming, reinstall_plugins=reinstall_plugins)
                for callback in _RESTORE_VALIDATORS:
                    callback(incoming)
                _prepare_installations(incoming, reinstall_plugins=reinstall_plugins)
                incoming.commit()
                _validate(incoming)
                with maintenance(Path(db.DB_PATH)):
                    live = db.connect()
                    try:
                        backup_name = _backup_live(live)
                        incoming.backup(live)
                        live.commit()
                    finally:
                        live.close()
            finally:
                incoming.close()
    return {"ok": True, "bytes": len(payload), "backup": backup_name,
            "validated": True, "indexes_rebuilt": len(_RESTORE_VALIDATORS),
            "reinstall_plugins": reinstall_plugins}


def _backup_live(live: sqlite3.Connection) -> str:
    folder = Path(db.DB_PATH).resolve().parent / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = _stamp()
    name = f"study-{stamp}.sqlite"
    path = folder / name
    index = 1
    while path.exists():
        name = f"study-{stamp}-{index}.sqlite"
        path = folder / name
        index += 1
    target = sqlite3.connect(path)
    try:
        live.backup(target)
    finally:
        target.close()
    return name


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")
