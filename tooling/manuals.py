"""Build and optionally deploy versioned manuals; never open product databases."""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def deploy(source, target, *, checker, full_package=False):
    source, target = Path(source).resolve(), Path(target).absolute()
    checker(source, published=True)
    if target.parent.name not in {"manual-publications", "plugin-publications"}:
        raise ValueError("Deployment requires an explicit publication directory")
    for path in [target, *target.parents]:
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("Deployment cannot use filesystem links")
    target.parent.mkdir(parents=True, exist_ok=True)
    pending = target.with_name(target.name + ".pending-" + uuid.uuid4().hex)
    if full_package:
        for path in source.rglob("*"):
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise ValueError("Package cannot contain filesystem links")
        shutil.copytree(source, pending)
    else:
        index = json.loads((source / "manual/manifest.json").read_text(encoding="utf-8"))
        for name in ["manual/manifest.json", *index["files"]]:
            destination = pending / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, destination)
    checker(pending, published=True)
    backup = None
    if target.exists():
        checker(target, published=True)
        backup = target.with_name(target.name + ".previous-" + uuid.uuid4().hex)
        target.rename(backup)
    try:
        pending.rename(target)
    except OSError:
        if backup is not None:
            backup.rename(target)
        raise
    return str(backup) if backup else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--studio-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--deploy", action="store_true", help="Replace only generated publications, retaining previous directories")
    args = parser.parse_args()
    studio, output = args.studio_root.resolve(), args.output.resolve()
    if output.exists() or output == ROOT or ROOT.is_relative_to(output) or studio.is_relative_to(output):
        raise ValueError("Build output must be a new directory")
    tool = studio / "tooling/build-manual/build_manual.py"
    output.mkdir(parents=True, exist_ok=False)
    builds = [
        ("platform", studio / "3dworkbench/docs/manual", []),
        ("tree", studio / "plugins/official/tree-view", ["--dependency", str(output / "platform/package")]),
        ("study", ROOT / "study-kb/docs/manual", []),
    ]
    for name, source, extra in builds:
        command = [sys.executable, str(tool), "--source", str(source), "--output", str(output / name), *extra]
        if name != "tree":
            command.extend(["--kind", "platform" if name == "platform" else "product"])
        subprocess.run(command, check=True, cwd=studio)
    sys.path.insert(0, str(studio / "tooling/build-manual"))
    from check_manual import check
    report = {"schema": "study.manual-release/v1", "publications": [], "backups": []}
    targets = {"platform": studio / "3dworkbench/manual-publications/workbench", "study": ROOT / "study-kb/manual-publications/study", "tree": studio / "plugin-publications/official.tree-view"}
    for name, _, _ in builds:
        package = output / name / "package"
        index = json.loads((package / "manual/manifest.json").read_text(encoding="utf-8"))
        report["publications"].append({key: index[key] for key in ("documentId", "version", "revision")})
        if args.deploy:
            previous = deploy(package, targets[name], checker=check, full_package=name == "tree")
            if previous:
                report["backups"].append(previous)
    archive = next((output / "tree").glob("*.zip"))
    report["treeArchiveSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "release.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
