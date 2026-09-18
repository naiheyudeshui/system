from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
STUDY_KB_TOOLS = REPO_ROOT / "study-kb" / "tools"
DEFAULT_DB = REPO_ROOT / "study-kb" / "data" / "study.sqlite"
IMPORTS_DIR = Path(__file__).resolve().parents[1] / "records" / "imports"
