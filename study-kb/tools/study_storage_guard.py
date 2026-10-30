"""Coordinate whole-library replacement with connections in every Study process.

The sidecar lock is deliberately outside SQLite: replacing a database's contents
must also exclude connections that have not started their next SQL transaction.
Normal connections share the lock. Restore waits for all of them to close before
publishing, and new connections wait until restore has finished.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

_LOCAL = threading.local()


class StorageBusy(ValueError):
    pass


class _FileLock:
    def __init__(self, path: Path, *, exclusive: bool, timeout: float):
        self.path = Path(str(Path(path).resolve()) + ".activity.lock")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        self._overlapped = None
        deadline = time.monotonic() + timeout
        while True:
            try:
                self._acquire(exclusive)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    self.stream.close()
                    raise StorageBusy("数据库正在使用或维护中，请稍后重试") from None
                time.sleep(0.025)

    def _acquire(self, exclusive):
        if os.name == "nt":
            import ctypes
            import msvcrt
            from ctypes import wintypes

            class OVERLAPPED(ctypes.Structure):
                _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                            ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                            ("hEvent", wintypes.HANDLE)]

            self._overlapped = OVERLAPPED()
            self._handle = wintypes.HANDLE(msvcrt.get_osfhandle(self.stream.fileno()))
            api = ctypes.WinDLL("kernel32", use_last_error=True)
            flags = 1 | (2 if exclusive else 0)  # FAIL_IMMEDIATELY | EXCLUSIVE
            if not api.LockFileEx(self._handle, flags, 0, 1, 0, ctypes.byref(self._overlapped)):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            import fcntl
            fcntl.flock(self.stream.fileno(), (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)

    def close(self):
        if self.stream.closed:
            return
        if os.name == "nt":
            import ctypes
            ctypes.WinDLL("kernel32", use_last_error=True).UnlockFileEx(
                self._handle, 0, 1, 0, ctypes.byref(self._overlapped))
        else:
            import fcntl
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()


def _owned():
    if not hasattr(_LOCAL, "maintenance"):
        _LOCAL.maintenance = set()
    return _LOCAL.maintenance


@contextmanager
def maintenance(path: Path, *, timeout: float = 8):
    key = str(Path(path).resolve())
    if key in _owned():
        yield
        return
    lock = _FileLock(Path(path), exclusive=True, timeout=timeout)
    _owned().add(key)
    try:
        yield
    finally:
        _owned().remove(key)
        lock.close()


class _GuardedConnection(sqlite3.Connection):
    def __init__(self, database, *args, **kwargs):
        self._activity_lock = None
        if str(Path(database).resolve()) not in _owned():
            self._activity_lock = _FileLock(Path(database), exclusive=False,
                                            timeout=kwargs.get("timeout", 8))
        try:
            super().__init__(database, *args, **kwargs)
        except BaseException:
            self._release()
            raise

    def _release(self):
        if self._activity_lock is not None:
            self._activity_lock.close()
            self._activity_lock = None

    def close(self):
        try:
            super().close()
        finally:
            self._release()

    def __del__(self):
        self._release()


def connect_guarded(path: Path, *, timeout: float = 8) -> sqlite3.Connection:
    return sqlite3.connect(path, timeout=timeout, factory=_GuardedConnection)
