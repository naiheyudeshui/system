"""One-command, clean-source manual/product verification; no live database."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, encoding="utf-8").strip()


def state(root):
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise ValueError("Expected an independent Git checkout: " + str(root))
    return {"commit": git(root, "rev-parse", "HEAD"), "dirty": bool(git(root, "status", "--porcelain"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--studio-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New output, preferably under ignored build/")
    parser.add_argument("--candidate-host", action="store_true", help="Compatibility only: derive an isolated product commit with a candidate host lock")
    args = parser.parse_args()
    host, output, product = args.studio_root.resolve(), args.output.resolve(), ROOT
    if output.exists() or any(root == output or root.is_relative_to(output) for root in (host, product)):
        raise ValueError("Verification requires a new, non-source output directory")
    inputs = {"host": state(host), "product": state(product)}
    if any(item["dirty"] for item in inputs.values()):
        raise ValueError("Commit the scoped source first; verification rejects dirty inputs")
    lock = json.loads((product / "tooling/dependencies.lock.json").read_text(encoding="utf-8"))
    if not args.candidate_host and lock["host"]["commit"] != inputs["host"]["commit"]:
        raise ValueError("Host differs from the product dependency lock")
    output.mkdir(parents=True)
    result = {"schema": "study.manual-verification/v1", "passed": False,
              "mode": "candidate-compatibility" if args.candidate_host else "locked-release",
              "inputs": inputs, "declaredHostCommit": lock["host"]["commit"], "steps": []}
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONPATH": os.pathsep.join(str(host / p) for p in ("tests", "3dworkbench/python", "tooling/build-manual"))}

    def save():
        (output / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def run(name, command, cwd, *, timeout=240, environment=None):
        started = time.monotonic()
        log = output / (name + ".log")
        print("[check] " + name, flush=True)
        entry = {"name": name, "command": [str(arg) for arg in command], "log": log.name}
        result["steps"].append(entry)
        save()
        try:
            with log.open("w", encoding="utf-8") as stream:
                completed = subprocess.run([str(arg) for arg in command], cwd=cwd, env=environment or env,
                                           stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
            entry.update(exitCode=completed.returncode, seconds=round(time.monotonic()-started, 3))
            save()
            if completed.returncode:
                raise RuntimeError(name + " failed; see " + str(log))
        except Exception as error:
            entry["error"] = str(error)
            save()
            raise

    try:
        if args.candidate_host:
            # Never edit the consumer's real lock or weaken production validation.
            product = output / "candidate-product"
            run("candidate-checkout", ["git", "worktree", "add", "--detach", product, inputs["product"]["commit"]], ROOT)
            lock["host"]["commit"] = inputs["host"]["commit"]
            (product / "tooling/dependencies.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
            run("candidate-stage-lock", ["git", "add", "--", "tooling/dependencies.lock.json"], product)
            candidate_env = {**env, "GIT_AUTHOR_DATE": "2026-10-30T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-30T00:00:00Z"}
            run("candidate-lock-commit", ["git", "-c", "user.name=Manual CI", "-c", "user.email=manual-ci@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test: bind isolated product to candidate host"], product, environment=candidate_env)
            result["derivedProduct"] = state(product)
        npm = "npm.cmd" if os.name == "nt" else "npm"
        for name in ("tests", "tests/contracts"):
            run("npm-" + name.replace("/", "-"), [npm, "ci", "--prefix", name, "--no-audit", "--no-fund"], host)
        node_tests = ["test_manual_registry.mjs", "test_system_help.mjs", "test_plugin_help.mjs", "test_system_help_packages.mjs", "test_plugin_sdk.mjs", "test_tree_package.mjs", "test_plugin_manager_ui.mjs", "test_pane_contract.mjs", "test_system_tools.mjs", "contracts/schema-parity.mjs"]
        run("node", ["node", "--test", *["tests/"+name for name in node_tests]], host)
        run("python-host", [sys.executable, "-m", "unittest", "test_manual_contracts", "test_manual_generator", "test_plugin_platform_v2", "test_plugin_manual", "test_manual_publications", "test_factory_structure", "test_data_schema_parity", "test_plugin_platform"], host)
        run("python-product", [sys.executable, "-m", "unittest", "test_product_build", "test_manual_deploy"], product,
            environment={**env, "PYTHONPATH": str(product / "study-kb/tests")})
        run("build-manuals", [sys.executable, "tooling/manuals.py", "--studio-root", host, "--output", output / "manuals", "--deploy"], product)
        runtime = {}
        for platform in ("web", "android"):
            runtime[platform] = output / ("runtime-" + platform)
            command = ([sys.executable, "tooling/build.py", "stage", "--platform", "web"] if platform == "web" else [sys.executable, "study-kb/tools/assemble_android_assets.py"])
            run("stage-"+platform, [*command, "--studio-root", host, "--output", runtime[platform], *(["--allow-dirty"] if args.candidate_host else [])], product)
            run("verify-"+platform, [sys.executable, "-S", "tooling/build.py", "verify", "--output", runtime[platform]], product)
        web = json.loads((runtime["web"] / "runtime-manifest.json").read_text(encoding="utf-8"))
        android = json.loads((runtime["android"] / "runtime-manifest.json").read_text(encoding="utf-8"))
        if web["files"] != android["files"] or any(item["provenance"]["development"] != args.candidate_host for item in (web, android)):
            raise ValueError("Runtime parity or release/candidate classification failed")
        result["runtime"] = {"files": len(web["files"]), "development": args.candidate_host,
                             "stamps": {key: (path / "runtime-stamp.txt").read_text().strip() for key, path in runtime.items()}}
        run("pack-parity", [sys.executable, "tooling/pack-plugin/pack_plugin.py", "--source", "plugins/official/tree-view", "--output", output / "tree-parity.zip", "--with-manual", "--dependency", output / "manuals/platform/package"], host)
        release = json.loads((output / "manuals/release.json").read_text(encoding="utf-8"))
        if hashlib.sha256((output / "tree-parity.zip").read_bytes()).hexdigest() != release["treeArchiveSha256"]:
            raise ValueError("Independent and pack-plugin ZIPs differ")
        for platform in ("web", "android"):
            run("browser-"+platform, [sys.executable, "tests/browser/unified_manual_check.py", "--runtime", runtime[platform], "--report", output / ("browser-"+platform+".json"), "--inventory", output / ("coverage-"+platform+".json")], host)
        run("browser-lifecycle", [sys.executable, "tests/browser/manual_lifecycle_check.py", "--report", output / "lifecycle.json"], host)
        run("browser-site", [sys.executable, "tests/browser/manual_check.py", "--package", output / "manuals/tree/package", "--screenshot", output / "site.png", "--report", output / "site.json"], host)
        if {"host": state(host), "product": state(ROOT)} != inputs or state(product)["dirty"]:
            raise ValueError("Source changed during verification")
        result["publications"] = release["publications"]
        result["treeArchiveSha256"] = release["treeArchiveSha256"]
        result["passed"] = True
        save()
        print(json.dumps({"passed": True, "mode": result["mode"], "report": str(output / "verification.json")}, ensure_ascii=False))
        return 0
    except Exception as error:
        result["error"] = str(error)
        save()
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
