"""Export and replace the live study SQLite library."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import db
from study_storage_guard import maintenance

SHARED_PYTHON = Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"
if str(SHARED_PYTHON) not in sys.path:
    sys.path.append(str(SHARED_PYTHON))

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
                _validate_managed_restore(incoming)
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


def file_bundles(files):
    """Product maintenance and business validation for the shared bundle engine."""
    from study_file_reference_audit import scan
    files.reference_scanners = (scan,)
    from file_bundles import FileBundles

    def prepare(connection):
        _validate(connection)
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not ({"study_knowledge_item", "study_card"} & tables):
            raise ValueError("文件里没有学习卡片表，已拒绝替换")
        db.ensure_schema(connection)
        _prepare_installations(connection, reinstall_plugins=True)
        for callback in _RESTORE_VALIDATORS:
            callback(connection)
        _prepare_installations(connection, reinstall_plugins=True)

    return FileBundles(files, maintenance=maintenance, prepare_restore=prepare)


def _validate_managed_restore(incoming):
    """A legacy SQLite restore may reuse available objects, never lose them silently.

    Preserve the existing storage-root identity. A DB without file metadata gets
    an empty compatible index; objects left by the previous library are retained.
    No assets from the live library are leaked into the imported metadata.
    """
    from contextlib import closing
    from file_assets import FileAssets
    from file_bundles import validate_file_references
    import os
    files = FileAssets(db.DB_PATH, root=os.environ.get("WORKBENCH_DATA_ROOT") or None, workspace_id="study")
    marker = files.root / "storage.json"
    incoming_tables = {row[0] for row in incoming.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "wb_file_asset" in incoming_tables:
        validate_file_references(incoming, files.blob_store)
    if not marker.is_file():
        if "wb_file_library" in incoming_tables:
            raise ValueError("SQLite含托管文件索引，但未挂接文件根；请导入完整ZIP备份")
        return
    status = files.status()
    with closing(files.connect()) as live:
        # These schema statements come from this local, trusted library, never
        # arbitrary archive-provided SQL. Only the known file service tables.
        names = ("wb_file_library", "wb_file_blob", "wb_file_asset", "wb_file_reference_owner",
                 "wb_file_reference", "wb_file_pin", "wb_storage_job", "wb_file_setting", "wb_external_reference")
        for name in names:
            if name in incoming_tables:
                continue
            row = live.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
            if row:
                incoming.execute(row[0])
    incoming.execute("INSERT OR REPLACE INTO wb_file_library(singleton,library_uuid) VALUES(1,?)", (status["libraryId"],))


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
