from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
STUDY_KB_TOOLS = REPO_ROOT / "study-kb" / "tools"
DEFAULT_DB = REPO_ROOT / "study-kb" / "data" / "study.sqlite"
BACKUP_DIR = REPO_ROOT / "study-kb" / "data" / "backups"
IMPORTS_DIR = Path(__file__).resolve().parents[1] / "records" / "imports"

_SERVER_URL_FILE = Path(__file__).resolve().parents[1] / "server.url"


def default_server_url() -> str:
    env = os.environ.get("STUDY_SERVER_URL", "").strip()
    if env:
        return env.rstrip("/")
    if _SERVER_URL_FILE.is_file():
        line = _SERVER_URL_FILE.read_text(encoding="utf-8").strip().splitlines()
        if line and not line[0].startswith("#"):
            return line[0].strip().rstrip("/")
    return "http://127.0.0.1:8033"


DEFAULT_SERVER_URL = default_server_url()
