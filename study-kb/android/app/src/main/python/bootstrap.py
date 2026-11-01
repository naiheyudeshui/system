"""Start the extracted study server inside the Android app."""

from __future__ import annotations

import os
import runpy
import sys


def main(runtime_root: str, contract_v2: bool = False, port: int = 8033) -> None:
    root = os.path.abspath(runtime_root)
    script = os.path.join(root, "study-kb", "tools", "serve_workbench.py")
    if not os.path.isfile(script):
        raise FileNotFoundError(script)
    tools = os.path.join(root, "study-kb", "tools")
    sys.path.insert(0, tools)
    from study_android_library import prepare_initial_library
    print("[StudyBootstrap] Preparing initial library files", flush=True)
    prepared = prepare_initial_library(root)
    print("[StudyBootstrap] Initial library: " +
          ("initialized" if prepared["initialized"] else prepared["reason"]), flush=True)
    os.chdir(root)
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.argv = [
        script,
        "--host",
        "0.0.0.0",
        "--port",
        str(port),
        "--no-open",
        "--trusted-lan-write",
    ]
    print(f"[StudyBootstrap] Starting HTTP service on port {port}", flush=True)
    runpy.run_path(script, run_name="__main__")
