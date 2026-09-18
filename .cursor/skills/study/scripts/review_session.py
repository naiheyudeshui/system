#!/usr/bin/env python3
"""Thin wrapper around study-kb review CLI."""

from __future__ import annotations

import sys

from _paths import STUDY_KB_TOOLS

sys.path.insert(0, str(STUDY_KB_TOOLS))

from study_review import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
