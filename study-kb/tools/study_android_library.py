"""Explicit, complete private library seeds for a personally built Android APK.

The normal APK build still refuses databases with detached file indexes. A
personal seed is accepted only with its validated full-library ZIP. First launch
publishes its file root atomically; existing installations keep their database
and have no pending seed marker, so an APK upgrade cannot replace their data.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

SHARED = Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"
if str(SHARED) not in sys.path:
    sys.path.append(str(SHARED))

SEED_TABLE = "study_android_initial_library"
BUNDLE_REL = "bootstrap/library.zip"
DATABASE_REL = "study-kb/data/study.sqlite"


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def content_digest(connection):
    """Bind a pending first-install marker to all packaged rows and SQL schema."""
    digest = hashlib.sha256()
    schema = list(connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>? ORDER BY type,name", (SEED_TABLE,)))
    for entry in schema:
        digest.update(json.dumps(tuple(entry), ensure_ascii=False, separators=(",", ":")).encode())
        if entry[0] == "table":
            name = entry[1].replace('"', '""')
            encoded = []
            for row in connection.execute(f'SELECT * FROM "{name}"'):
                values = [dict(blob=value.hex()) if isinstance(value, bytes) else value for value in row]
                encoded.append(json.dumps(values, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
            for value in sorted(encoded):
                digest.update(b"\n")
                digest.update(value.encode())
    return digest.hexdigest()


def validate_bundle(archive_path, stage):
    from file_assets import FileAssets
    from file_bundles import FileBundles, _asset_rows, validate_database
    service = FileAssets(Path(stage) / "unused.sqlite", workspace_id="study")
    manifest = FileBundles(service).validate(archive_path, stage)
    if manifest["scope"] != "library" or manifest["workspaceId"] != "study":
        raise ValueError("Initial APK data requires a complete Study library ZIP")
    with closing(sqlite3.connect(Path(stage) / "database.sqlite")) as con:
        validate_database(con)
        found = con.execute("SELECT library_uuid FROM wb_file_library WHERE singleton=1").fetchone()
        if not found or found[0] != manifest["libraryId"]:
            raise ValueError("Seed database and bundle storage identities differ")
        actual = {(r[0], r[1], r[2], r[3], r[4], r[5]) for r in _asset_rows(con)}
        declared = {(a["assetId"], a["workspaceId"], a["sha256"], a["bytes"], a["mediaType"], a["name"]) for a in manifest["assets"]}
        if actual != declared:
            raise ValueError("Initial library asset metadata differs from the archive")
        if con.execute("SELECT 1 FROM sqlite_master WHERE name=?", (SEED_TABLE,)).fetchone():
            raise ValueError("An initial-seed database cannot be packaged recursively")
    return manifest


def pack_library(archive_path, destination, copied):
    archive_path, destination = Path(archive_path).resolve(strict=True), Path(destination)
    before_hash = checksum(archive_path)
    with tempfile.TemporaryDirectory(prefix="study-apk-library-") as directory:
        stage = Path(directory)
        manifest = validate_bundle(archive_path, stage)
        target = destination / DATABASE_REL
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(stage / "database.sqlite", target)
        with closing(sqlite3.connect(target)) as con:
            _install_shipped_permissions(con)
            fingerprint = content_digest(con)
            con.execute(f"CREATE TABLE {SEED_TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bundle_sha256 TEXT NOT NULL,content_sha256 TEXT NOT NULL,library_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','complete')))")
            con.execute(f"INSERT INTO {SEED_TABLE} VALUES(1,?,?,?,'pending')", (before_hash, fingerprint, manifest["libraryId"]))
            con.commit()
        bundle_target = destination / BUNDLE_REL
        bundle_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(archive_path, bundle_target)
        if checksum(bundle_target) != before_hash:
            raise ValueError("Initial library archive changed while packaging")
        copied[DATABASE_REL] = checksum(target)
        copied[BUNDLE_REL] = before_hash


def _install_shipped_permissions(con):
    """Personal APK approval covers its shipped code, never ZIP manifests.

    Portable backups intentionally strip execution grants. Rebuild grants only
    from plugin.json files actually shipped by this build, using the selected
    host checkout. Unknown third-party packages remain disabled in the seed.
    """
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='workbench_plugin_grant'").fetchone():
        return
    repo = Path(__file__).resolve().parents[2]
    studio = Path(os.environ.get("STUDY_STUDIO_ROOT", repo / "3dStudio")).resolve()
    shipped = {}
    for folder in (repo / "study-kb/plugins", studio / "3dworkbench/plugins/official"):
        for path in folder.glob("*/plugin.json"):
            descriptor = json.loads(path.read_text(encoding="utf-8"))
            identity = descriptor["id"]
            if identity in shipped:
                raise ValueError("Duplicate shipped plugin identity")
            shipped[identity] = descriptor
    for (identity,) in con.execute("SELECT plugin_id FROM workbench_plugin WHERE state='enabled'").fetchall():
        descriptor = shipped.get(identity)
        con.execute("DELETE FROM workbench_plugin_grant WHERE plugin_id=?", (identity,))
        if descriptor is None:
            con.execute("UPDATE workbench_plugin SET state='disabled' WHERE plugin_id=?", (identity,))
            continue
        for capability in descriptor.get("permissions", []):
            con.execute("INSERT INTO workbench_plugin_grant(plugin_id,capability,granted) VALUES(?,?,1)", (identity, capability))


def prepare_initial_library(runtime_root):
    """One-time file hydration only. Never replace an installed SQLite library."""
    from file_assets import FileAssets
    from file_blob_store import FileBlobStore
    from file_bundles import validate_database, validate_file_references
    from study_storage_guard import maintenance

    root = Path(runtime_root).resolve()
    database = root / DATABASE_REL
    if not database.is_file():
        return {"initialized": False, "reason": "no-seed"}
    with maintenance(database), closing(sqlite3.connect(database)) as connection:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (SEED_TABLE,)).fetchone():
            return {"initialized": False, "reason": "existing-installation"}
        marker = connection.execute(f"SELECT bundle_sha256,content_sha256,library_id,state FROM {SEED_TABLE} WHERE singleton=1").fetchone()
        if not marker:
            raise ValueError("Invalid initial-library marker")
        if marker[3] == "complete":
            return {"initialized": False, "reason": "already-complete"}
        archive_path = root / BUNDLE_REL
        if checksum(archive_path) != marker[0] or content_digest(connection) != marker[1]:
            raise ValueError("Pending initial library differs from its packaged snapshot")
        files = FileAssets(database, workspace_id="study")
        with tempfile.TemporaryDirectory(prefix=".initial-library-", dir=database.parent) as directory:
            stage = Path(directory)
            manifest = validate_bundle(archive_path, stage)
            if manifest["libraryId"] != marker[2]:
                raise ValueError("Initial library identity mismatch")
            if not files.root.exists():
                # Nothing is visible as the live file root until every object has
                # passed checksum validation. A failed attempt can be retried.
                staged_store = FileBlobStore(stage / "files")
                staged_store.initialize(marker[2])
                for asset in manifest["assets"]:
                    with (stage / "objects/sha256" / asset["sha256"]).open("rb") as stream:
                        result = staged_store.publish_stream(stream, asset["bytes"])
                    if result["sha256"] != asset["sha256"]:
                        raise ValueError("Initial object hash mismatch")
                validate_file_references(connection, staged_store)
                os.rename(staged_store.root, files.root)
            files.blob_store.verify_identity(marker[2])
            validate_database(connection)
            validate_file_references(connection, files.blob_store)
            connection.execute(f"UPDATE {SEED_TABLE} SET state='complete' WHERE singleton=1")
            connection.commit()
        return {"initialized": True, "assets": len(manifest["assets"])}
