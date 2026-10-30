"""Run acceptance against a disposable main-data copy; never changes the source.

The artifact directory contains private data and must stay outside Git. Stop the
fixture by closing stdin. No built-in package registry is seeded here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "study-kb/tools"))


def fingerprint(path):
    con = sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True)
    try:
        con.execute("BEGIN")
        tables = {}
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            # Sort row digests, so physical row order and migrated indexes do not
            # affect the evidence. Content never appears in the report.
            rows = []
            for row in con.execute(f"SELECT * FROM {quoted}"):
                encoded = json.dumps(row, ensure_ascii=False, default=lambda v: {"blob": v.hex()}, separators=(",", ":")).encode()
                rows.append(hashlib.sha256(encoded).digest())
            tables[name] = {"rows": len(rows), "sha256": hashlib.sha256(b"".join(sorted(rows))).hexdigest()}
        return tables
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--snapshot-only", action="store_true")
    parser.add_argument("--resume", action="store_true", help="restart this existing isolated fixture without replacing its data")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    folder = args.artifacts.resolve()
    if folder == source.parent or source in folder.parents:
        raise ValueError("artifact directory must be separate from source")
    folder.mkdir(parents=True, exist_ok=True)
    snapshot = folder / "main-source.sqlite"
    live = folder / "acceptance.sqlite"
    if args.resume:
        if not snapshot.is_file() or not live.is_file():
            raise ValueError("resume requires an existing fixture and main snapshot")
        recorded = json.loads((folder / "main-source-inventory.json").read_text(encoding="utf-8"))
        if Path(recorded["source"]).resolve() != source:
            raise ValueError("source does not match this fixture's inventory")
        tables = recorded["tables"]
    elif snapshot.exists() or live.exists():
        raise ValueError("use a new artifact directory; previous acceptance data is preserved")
    else:
        incoming = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(snapshot)
        try:
            incoming.backup(target)
        finally:
            target.close()
            incoming.close()
        tables = fingerprint(snapshot)
        source_report = {"source": str(source), "snapshot": str(snapshot), "tables": tables}
        (folder / "main-source-inventory.json").write_text(json.dumps(source_report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.snapshot_only:
        print(json.dumps({"snapshot": str(snapshot), "inventory": str(folder / "main-source-inventory.json"), "tables": len(tables)}), flush=True)
        return

    import db
    import serve_workbench
    db.DB_PATH = live
    db.connect().close()
    serve_workbench.STUDY_DB = live
    serve_workbench._install_db_shim()
    serve_workbench._install_workbench_study_shim()
    import study_workbench_patch
    study_workbench_patch.install()
    import workbench_server
    # Both package store and DB are dedicated to this fixture.
    workbench_server.PLUGIN_PACKAGE_ROOT = folder / "plugin-packages"
    server = workbench_server.WorkbenchHTTPServer(("127.0.0.1", args.port), workbench_server.make_handler(ROOT / "study-kb/web"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_address[1]}", "database": str(live),
                      "snapshot": str(snapshot), "artifacts": str(folder), "source_tables": len(tables)}), flush=True)
    try:
        sys.stdin.readline()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
