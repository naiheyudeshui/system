"""Inspect/stage/verify Study's platform-neutral runtime, never user data.

This additive entry does not replace Gradle or sign apps. A successful stage is
a resource composition, not proof of Android/iOS or business readiness.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import runpy
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METADATA = {"runtime-manifest.json", "runtime-manifest.txt", "runtime-stamp.txt"}
PRIVATE_DIRS = {".git", "node_modules", "__pycache__", "data", "backups", ".gradle", ".venv", "build", "dist-info"}
PRIVATE_SUFFIXES = {".sqlite", ".sqlite3", ".db", ".log", ".ndjson", ".pyc", ".pyo", ".key", ".pem", ".p8", ".p12", ".pfx", ".keystore", ".jks"}
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)


class ProductBuildError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def commit(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 240 or any(c in value for c in "\\:%?#<>\"|*"):
        raise ProductBuildError("Unsafe relative resource path")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part[-1:] in {".", " "} or RESERVED.fullmatch(part) or any(ord(c) < 32 or ord(c) == 127 for c in part) for part in parts):
        raise ProductBuildError("Unsafe relative resource path: " + value)
    return value


def load_json(path):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ProductBuildError("Duplicate JSON key: " + key)
            value[key] = item
        return value
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ProductBuildError("Manifest exceeds size budget")
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ProductBuildError("Non-finite JSON value")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ProductBuildError("Invalid manifest JSON: " + path.name) from error


def source_state(root):
    def git(*args):
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)
        return result.stdout.strip()
    try:
        if Path(git("rev-parse", "--show-toplevel")).resolve() != root.resolve():
            return {"commit": None, "dirty": True}
        return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "dirty": True}


def is_link(path):
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def checked_source(root, name):
    path = root / relative(name)
    current = path
    while current != root:
        if is_link(current):
            raise ProductBuildError("Source resource contains filesystem link: " + name)
        current = current.parent
    if not path.resolve().is_relative_to(root) or not path.exists():
        raise ProductBuildError("Missing/escaping source: " + name)
    return path


def private(name):
    parts = Path(name).parts
    return (any(part.casefold() in PRIVATE_DIRS or part.startswith(".") for part in parts)
            or Path(name).suffix.casefold() in PRIVATE_SUFFIXES
            or ".sqlite-" in name.casefold() or name.casefold().endswith(".activity.lock"))


def source_files(path, *, skip_private_dirs=True):
    if path.is_file():
        yield path
        return
    for current, directories, names in os.walk(path, followlinks=False):
        directories[:] = sorted(name for name in directories if not skip_private_dirs or name.casefold() not in PRIVATE_DIRS and not name.startswith("."))
        for name in directories:
            if is_link(Path(current) / name):
                raise ProductBuildError("Source tree contains filesystem link")
        for name in sorted(names):
            candidate = Path(current) / name
            if is_link(candidate):
                raise ProductBuildError("Source tree contains filesystem link")
            if not candidate.is_file():
                raise ProductBuildError("Source tree contains a non-regular file")
            yield candidate


def context(product_root=ROOT, studio_root=None, *, allow_dirty=False):
    product_root = Path(product_root).resolve()
    studio_root = Path(studio_root or os.environ.get("STUDY_STUDIO_ROOT") or product_root / "3dStudio").resolve()
    if not studio_root.is_dir():
        raise ProductBuildError("Host missing; supply --studio-root or STUDY_STUDIO_ROOT")
    manifest = load_json(checked_source(product_root, "tooling/product.json"))
    # Host source is an explicit trusted build input, not plugin-uploaded code.
    helpers = runpy.run_path(str(studio_root / "tooling/sync-contracts/validate_contracts.py"))
    validators = helpers["validators"]()
    try:
        validators["product-build.schema.json"].validate(manifest)
        lock = load_json(checked_source(product_root, manifest["hostDependency"]))
        validators["product-dependencies.schema.json"].validate(lock)
    except Exception as error:
        if isinstance(error, ProductBuildError):
            raise
        raise ProductBuildError("Product/lock contract invalid: " + str(error)[:250]) from error
    host_state, product_state = source_state(studio_root), source_state(product_root)
    if host_state["commit"] != lock["host"]["commit"]:
        raise ProductBuildError("Host commit differs from dependency lock; select the locked checkout")
    if not commit(product_state["commit"]):
        raise ProductBuildError("Product root must be its own Git checkout")
    if not allow_dirty and (host_state["dirty"] or product_state["dirty"]):
        raise ProductBuildError("Dirty/unversioned input; --allow-dirty is development-only")
    return manifest, {"product": product_root, "host": studio_root}, {
        "product": product_state, "host": host_state,
        "expectedHostCommit": lock["host"]["commit"],
        "development": bool(allow_dirty),
    }


def inventory(manifest, roots, *, platform):
    config = manifest["platforms"].get(platform)
    if not config or config["status"] != "available":
        raise ProductBuildError("Platform is not implemented: " + platform)
    selected, source_roots = {}, []
    for rule in manifest["resources"]:
        root = roots[rule["owner"]]
        source = checked_source(root, rule["source"])
        source_roots.append(source)
        target = relative(rule["target"])
        matched = 0
        for path in source_files(source):
            suffix = path.relative_to(source).as_posix() if source.is_dir() else ""
            destination = relative(target + ("/" + suffix if suffix else ""))
            if private(destination) or not any(fnmatch.fnmatchcase(path.name, pattern) for pattern in rule["include"]) or any(fnmatch.fnmatchcase(path.name, pattern) for pattern in rule["exclude"]):
                continue
            key = destination.casefold()
            if key in selected:
                raise ProductBuildError("Case-colliding/duplicate target: " + destination)
            selected[key] = (destination, path, {"owner": rule["owner"], "source": path.relative_to(root).as_posix()})
            matched += 1
        if not matched:
            raise ProductBuildError("Resource rule selected no files: " + rule["source"])
    ordered = sorted(selected)
    for first, second in zip(ordered, ordered[1:]):
        if second.startswith(first + "/"):
            raise ProductBuildError("Target file is also used as directory")
    by_name = {value[0]: value for value in selected.values()}
    for entry in manifest["entry"].values():
        if entry not in by_name:
            raise ProductBuildError("Product entry not included: " + entry)
    if any(name.casefold() in METADATA for name in by_name):
        raise ProductBuildError("Resource occupies generated metadata path")
    # A declared manual is a release input, not a promise that source Markdown
    # might be found on the machine. Require the publication and all its files.
    for document in manifest.get("documents", []):
        publication = document["publication"]
        if publication not in by_name:
            raise ProductBuildError("Manual publication not staged: " + publication)
        index = load_json(by_name[publication][1])
        if index.get("documentId") != document["documentId"] or index.get("schema") != "workbench.manual-index/v1":
            raise ProductBuildError("Manual publication identity mismatch")
        prefix = publication.removesuffix("manual/manifest.json")
        for name, expected in index["files"].items():
            destination = relative(prefix + relative(name))
            if destination not in by_name:
                raise ProductBuildError("Manual resource not staged: " + destination)
            content = by_name[destination][1].read_bytes()
            if len(content) != expected["bytes"] or hashlib.sha256(content).hexdigest() != expected["sha256"]:
                raise ProductBuildError("Manual resource hash mismatch: " + destination)
    return by_name, source_roots


def stage(output, *, product_root=ROOT, studio_root=None, platform="web", allow_dirty=False):
    manifest, roots, provenance = context(product_root, studio_root, allow_dirty=allow_dirty)
    selected, inputs = inventory(manifest, roots, platform=platform)
    output = Path(output).resolve()
    if output.exists() or any(root == output or root.is_relative_to(output) for root in roots.values()) or any(output == item or output.is_relative_to(item) for item in inputs):
        raise ProductBuildError("Output must be new and outside selected source trees")
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for destination, source, origin in (selected[name] for name in sorted(selected)):
        content = source.read_bytes()
        target = output / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        files[destination] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), **origin}
    record = {"schema": "workbench.runtime-resources/v1", "productId": manifest["id"], "version": manifest["version"], "platform": platform,
              "dataPolicy": manifest["dataPolicy"], "provenance": provenance, "entry": manifest["entry"], "files": files}
    stamp = hashlib.sha256(canonical(record)).hexdigest()
    (output / "runtime-manifest.json").write_bytes(canonical(record) + b"\n")
    (output / "runtime-manifest.txt").write_text("\n".join(files) + "\n", encoding="utf-8", newline="\n")
    (output / "runtime-stamp.txt").write_text(stamp + "\n", encoding="utf-8", newline="\n")
    return verify(output)


def verify(output):
    """Verify a staged tree using only stdlib, even without a host checkout."""
    output = Path(output).absolute()
    if is_link(output):
        raise ProductBuildError("Runtime root cannot be a filesystem link")
    output = output.resolve()
    for name in METADATA:
        if not checked_source(output, name).is_file():
            raise ProductBuildError("Runtime metadata must be regular files")
    record = load_json(output / "runtime-manifest.json")
    if not isinstance(record, dict) or set(record) != {"schema", "productId", "version", "platform", "dataPolicy", "provenance", "entry", "files"} or record["schema"] != "workbench.runtime-resources/v1" or record["dataPolicy"] != "external-runtime-data":
        raise ProductBuildError("Invalid runtime manifest")
    if hashlib.sha256(canonical(record)).hexdigest() != (output / "runtime-stamp.txt").read_text(encoding="utf-8").strip():
        raise ProductBuildError("Runtime manifest stamp mismatch")
    files = record["files"]
    if not isinstance(files, dict) or not files or len(files) > 20000:
        raise ProductBuildError("Invalid runtime file inventory")
    if (output / "runtime-manifest.txt").read_text(encoding="utf-8") != "\n".join(sorted(files)) + "\n":
        raise ProductBuildError("Runtime text inventory mismatch")
    actual = set()
    for path in source_files(output, skip_private_dirs=False):
        name = path.relative_to(output).as_posix()
        if name in METADATA:
            continue
        actual.add(relative(name))
        if private(name) or name not in files:
            raise ProductBuildError("Unlisted/private runtime file: " + name)
    if actual != set(files):
        raise ProductBuildError("Missing/unlisted runtime resources")
    for name, expected in files.items():
        relative(name)
        path = checked_source(output, name)
        if (not isinstance(expected, dict) or set(expected) != {"bytes", "sha256", "owner", "source"}
                or expected["owner"] not in ("host", "product")
                or type(expected["bytes"]) is not int or expected["bytes"] < 0
                or not isinstance(expected["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"])):
            raise ProductBuildError("Invalid runtime resource metadata")
        relative(expected["source"])
        data = path.read_bytes()
        if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ProductBuildError("Changed runtime resource: " + name)
    if (not isinstance(record["entry"], dict) or set(record["entry"]) != {"server", "web"}
            or any(not isinstance(name, str) or name not in files for name in record["entry"].values())
            or not isinstance(record["platform"], str) or record["platform"] not in {"web", "android"}
            or not isinstance(record["productId"], str) or not re.fullmatch(r"[a-z][a-z0-9.-]*", record["productId"])
            or not isinstance(record["version"], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", record["version"])):
        raise ProductBuildError("Invalid runtime identity/entry")
    provenance = record["provenance"]
    if (not isinstance(provenance, dict) or set(provenance) != {"product", "host", "expectedHostCommit", "development"}
            or type(provenance["development"]) is not bool or not commit(provenance["expectedHostCommit"])):
        raise ProductBuildError("Invalid runtime provenance")
    for owner in ("product", "host"):
        state = provenance[owner]
        if (not isinstance(state, dict) or set(state) != {"commit", "dirty"}
                or not commit(state["commit"]) or type(state["dirty"]) is not bool
                or state["dirty"] and not provenance["development"]):
            raise ProductBuildError("Invalid runtime source state")
    if provenance["host"]["commit"] != provenance["expectedHostCommit"]:
        raise ProductBuildError("Runtime host does not match dependency lock")
    return {"productId": record["productId"], "platform": record["platform"], "fileCount": len(files),
            "bytes": sum(value["bytes"] for value in files.values()), "stamp": hashlib.sha256(canonical(record)).hexdigest(),
            "development": record["provenance"]["development"], "dataPolicy": record["dataPolicy"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("doctor", "stage", "verify"))
    parser.add_argument("--product-root", type=Path, default=ROOT)
    parser.add_argument("--studio-root", type=Path)
    parser.add_argument("--platform", choices=("web", "android", "ios"), default="web")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "verify":
            if args.output is None:
                raise ProductBuildError("verify requires --output")
            result = verify(args.output)
        elif args.command == "stage":
            if args.output is None:
                raise ProductBuildError("stage requires a new --output directory")
            result = stage(args.output, product_root=args.product_root, studio_root=args.studio_root, platform=args.platform, allow_dirty=args.allow_dirty)
        else:
            manifest, roots, provenance = context(args.product_root, args.studio_root, allow_dirty=args.allow_dirty)
            files, _ = inventory(manifest, roots, platform=args.platform)
            result = {"productId": manifest["id"], "platform": args.platform, "fileCount": len(files), "provenance": provenance,
                      "dataPolicy": manifest["dataPolicy"], "documents": manifest["documents"], "manualPublicationsBuilt": False}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ProductBuildError, OSError, KeyError, TypeError) as error:
        print(f"Product build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
