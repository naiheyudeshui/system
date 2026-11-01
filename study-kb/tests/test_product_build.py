"""Portable staging tests use fictional files, never a learning database."""
import copy
import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("study_product_build", ROOT / "tooling/build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ProductBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="study-product-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.manifest = {"schema": "workbench.product-build/v1", "id": "study", "version": "1.0.4", "hostDependency": "tooling/dependencies.lock.json",
            "entry": {"server": "study-kb/tools/server.py", "web": "study-kb/web/index.html"}, "dataPolicy": "external-runtime-data",
            "platforms": {"web": {"status": "available"}, "android": {"status": "available"}, "ios": {"status": "planned"}}, "documents": [],
            "resources": [{"owner": "product", "source": "tools", "target": "study-kb/tools", "include": ["*.py"], "exclude": []},
                          {"owner": "product", "source": "web", "target": "study-kb/web", "include": ["*"], "exclude": []},
                          {"owner": "host", "source": "web", "target": "3dStudio/web", "include": ["*"], "exclude": []}]}
        self.provenance = {"product": {"commit": "b" * 40, "dirty": False}, "host": {"commit": "a" * 40, "dirty": False}, "expectedHostCommit": "a" * 40, "development": True}
        self.roots = self.fixture("first machine")

    def fixture(self, directory):
        roots = {"product": self.base / directory / "system", "host": self.base / directory / "shared"}
        for owner, paths in {"product": {"tools/server.py": b"# fixture\n", "web/index.html": b"<title>Study fixture</title>", "web/users.sqlite": b"private fixture, not a real database", "web/.env": b"fixture secret", "web/signing.pem": b"fixture key", "web/runtime.log": b"fixture log", "web/data/never.json": b"{}"}, "host": {"web/host.mjs": b"export const fixture = true;"}}.items():
            for name, data in paths.items():
                path = roots[owner] / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        return {owner: root.resolve() for owner, root in roots.items()}

    def stage(self, name="out", roots=None, manifest=None):
        with patch.object(builder, "context", return_value=(manifest or self.manifest, roots or self.roots, self.provenance)):
            return builder.stage(self.base / name)

    def test_relocated_roots_without_junction_produce_identical_stamps(self):
        first = self.stage()
        second = self.stage("other output", roots=self.fixture("different machine"))
        self.assertEqual(first["stamp"], second["stamp"])
        record = (self.base / "out/runtime-manifest.json").read_text(encoding="utf-8")
        self.assertNotIn(str(self.base), record)
        self.assertEqual(first["fileCount"], 3)
        self.assertFalse(list((self.base / "out").rglob("*.sqlite")))

    def test_existing_output_is_never_replaced(self):
        target = self.base / "out"
        target.mkdir()
        (target / "keep.txt").write_text("keep", encoding="utf-8")
        with self.assertRaises(builder.ProductBuildError):
            self.stage()
        self.assertEqual((target / "keep.txt").read_text(encoding="utf-8"), "keep")

    def test_output_inside_an_input_tree_is_rejected_before_write(self):
        with patch.object(builder, "context", return_value=(self.manifest, self.roots, self.provenance)), self.assertRaises(builder.ProductBuildError):
            builder.stage(self.roots["product"] / "web/generated")
        self.assertFalse((self.roots["product"] / "web/generated").exists())

    def test_case_colliding_rules_and_path_escape_are_rejected(self):
        bad = copy.deepcopy(self.manifest)
        bad["resources"].append({**bad["resources"][1], "target": "study-kb/WEB"})
        with self.assertRaises(builder.ProductBuildError):
            self.stage(manifest=bad)
        bad = copy.deepcopy(self.manifest)
        bad["resources"][0]["target"] = "../outside"
        with self.assertRaises(builder.ProductBuildError):
            self.stage(manifest=bad)

    def test_planned_platform_cannot_be_reported_as_built(self):
        with patch.object(builder, "context", return_value=(self.manifest, self.roots, self.provenance)), self.assertRaises(builder.ProductBuildError):
            builder.stage(self.base / "ios-out", platform="ios")
        self.assertFalse((self.base / "ios-out").exists())

    def test_changed_or_missing_file_fails_verification(self):
        self.stage()
        path = self.base / "out/study-kb/web/index.html"
        path.write_bytes(b"changed")
        with self.assertRaises(builder.ProductBuildError):
            builder.verify(self.base / "out")
        path.unlink()
        with self.assertRaises(builder.ProductBuildError):
            builder.verify(self.base / "out")

    def test_private_files_added_after_staging_are_not_hidden_by_traversal(self):
        self.stage()
        path = self.base / "out/data/private.sqlite"
        path.parent.mkdir()
        path.write_bytes(b"fixture")
        with self.assertRaises(builder.ProductBuildError):
            builder.verify(self.base / "out")

    def test_manifest_tamper_and_text_inventory_tamper_are_rejected(self):
        self.stage()
        path = self.base / "out/runtime-manifest.txt"
        path.write_text("incomplete\n", encoding="utf-8")
        with self.assertRaises(builder.ProductBuildError):
            builder.verify(self.base / "out")

    def test_verifier_needs_no_host_checkout(self):
        self.stage()
        with patch.object(builder, "context", side_effect=AssertionError("must not resolve host")):
            self.assertEqual(builder.verify(self.base / "out")["fileCount"], 3)

    def test_missing_entry_is_rejected(self):
        bad = copy.deepcopy(self.manifest)
        bad["entry"]["server"] = "missing/server.py"
        with self.assertRaises(builder.ProductBuildError):
            self.stage(manifest=bad)

    def test_links_are_rejected_when_platform_supports_creating_them(self):
        link = self.roots["product"] / "web/linked.mjs"
        try:
            link.symlink_to(self.roots["host"] / "web/host.mjs")
        except OSError:
            self.skipTest("Host account cannot create symbolic links")
        with self.assertRaises(builder.ProductBuildError):
            self.stage()

    def test_runtime_metadata_links_are_rejected_before_json_is_read(self):
        self.stage()
        path = self.base / "out/runtime-manifest.json"
        outside = self.base / "outside.json"
        outside.write_bytes(b"invalid JSON must never be parsed")
        path.unlink()
        try:
            path.symlink_to(outside)
        except OSError:
            self.skipTest("Host account cannot create symbolic links")
        with self.assertRaisesRegex(builder.ProductBuildError, "filesystem link"):
            builder.verify(self.base / "out")

    def test_relative_paths_reject_windows_and_url_aliases(self):
        for path in ("../x", "C:/x", "a\\x", "/x", "a/%2e%2e/x", "a/CON.json", "a/x.", "a//x"):
            with self.subTest(path=path), self.assertRaises(builder.ProductBuildError):
                builder.relative(path)

    def context(self, *, allow_dirty=False, host_commit="a" * 40, dirty=False, product_commit="b" * 40):
        directory = self.roots["product"] / "tooling"
        directory.mkdir(exist_ok=True)
        (directory / "product.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (directory / "dependencies.lock.json").write_text(json.dumps({"schema": "workbench.product-dependencies/v1", "host": {"repository": "https://github.com/example/shared.git", "commit": "a" * 40}}), encoding="utf-8")
        validators = {name: Mock() for name in ("product-build.schema.json", "product-dependencies.schema.json")}
        with patch.object(builder.runpy, "run_path", return_value={"validators": lambda: validators}), patch.object(builder, "source_state", side_effect=[{"commit": host_commit, "dirty": dirty}, {"commit": product_commit, "dirty": dirty}]):
            return builder.context(self.roots["product"], self.roots["host"], allow_dirty=allow_dirty)

    def test_dependency_lock_cannot_be_bypassed_by_allow_dirty(self):
        for allow in (False, True):
            with self.subTest(allow=allow), self.assertRaisesRegex(builder.ProductBuildError, "commit differs"):
                self.context(allow_dirty=allow, host_commit="c" * 40)

    def test_development_flag_is_explicit_and_unversioned_root_is_rejected(self):
        self.assertFalse(self.context()[2]["development"])
        with self.assertRaisesRegex(builder.ProductBuildError, "Dirty/unversioned"):
            self.context(dirty=True)
        self.assertTrue(self.context(allow_dirty=True, dirty=True)[2]["development"])
        with self.assertRaisesRegex(builder.ProductBuildError, "own Git checkout"):
            self.context(allow_dirty=True, product_commit=None)

    def test_rehashed_manifest_still_requires_meaningful_provenance_and_entries(self):
        self.stage()
        path = self.base / "out/runtime-manifest.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        mutations = (
            lambda r: r.update(provenance=[]),
            lambda r: r.update(entry={"server": "missing.py", "web": "missing.html"}),
            lambda r: r["provenance"]["host"].update(commit="c" * 40),
            lambda r: r["provenance"].update(development=False, host={"commit": "a" * 40, "dirty": True}),
            lambda r: r["files"]["study-kb/web/index.html"].update(bytes=True),
        )
        for mutate in mutations:
            record = copy.deepcopy(original)
            mutate(record)
            path.write_bytes(builder.canonical(record))
            (self.base / "out/runtime-stamp.txt").write_text(hashlib.sha256(builder.canonical(record)).hexdigest(), encoding="utf-8")
            with self.subTest(mutate=mutate), self.assertRaises(builder.ProductBuildError):
                builder.verify(self.base / "out")


if __name__ == "__main__":
    unittest.main()
