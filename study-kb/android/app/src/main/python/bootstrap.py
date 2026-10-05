"""Start the extracted study server inside the Android app."""

from __future__ import annotations

import os
import runpy
import sys


def main(runtime_root: str) -> None:
    root = os.path.abspath(runtime_root)
    script = os.path.join(root, "study-kb", "tools", "serve_workbench.py")
    if not os.path.isfile(script):
        raise FileNotFoundError(script)
    os.chdir(root)
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.argv = [
        script,
        "--host",
        "0.0.0.0",
        "--port",
        "8033",
        "--no-open",
        "--trusted-lan-write",
    ]
    runpy.run_path(script, run_name="__main__")
