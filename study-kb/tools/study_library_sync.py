"""Export and replace the live study SQLite library."""

from __future__ import annotations

import sqlite3
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import db

MAX_BYTES = 128 * 1024 * 1024
_LOCK = threading.Lock()
_HEADER = b"SQLite format 3\x00"


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


def import_library(payload: bytes) -> dict:
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
            incoming = sqlite3.connect(f"file:{incoming_path.as_posix()}?mode=ro", uri=True)
            try:
                found = incoming.execute(
                    """SELECT 1 FROM sqlite_master
                       WHERE type='table' AND name IN ('study_knowledge_item', 'study_card')"""
                ).fetchone()
                if not found:
                    raise ValueError("文件里没有学习卡片表，已拒绝替换")
                live = db.connect()
                try:
                    backup_name = _backup_live(live)
                    incoming.backup(live)
                    db.ensure_schema(live)
                    live.commit()
                finally:
                    live.close()
            finally:
                incoming.close()
    return {"ok": True, "bytes": len(payload), "backup": backup_name}


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
