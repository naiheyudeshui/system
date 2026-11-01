"""Packaging guards and host entrypoint tests; no library or phone mutation."""
import importlib.util
import os
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AndroidContractBuildTest(unittest.TestCase):
    def test_missing_branch_source_does_not_erase_existing_staging(self):
        assembler = load("contract_assets_missing", ROOT / "tools/assemble_android_assets.py")
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            dest = base / "staging"
            dest.mkdir()
            marker = dest / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            with patch.object(assembler, "CONTRACT_V2", True), \
                    patch.object(assembler, "STUDIO_ROOT", base / "missing"), \
                    patch.object(assembler, "DEST_ROOT", dest):
                with self.assertRaisesRegex(RuntimeError, "source missing"):
                    assembler.assemble()
            self.assertEqual("keep", marker.read_text(encoding="utf-8"))

    def test_wrong_branch_does_not_erase_existing_staging(self):
        assembler = load("contract_assets_main", ROOT / "tools/assemble_android_assets.py")
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for rel in ("3dworkbench/python/command_gateway.py", "3dworkbench/contracts/data-binding.schema.json"):
                file = base / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("fixture", encoding="utf-8")
            with patch.object(assembler, "CONTRACT_V2", True), \
                    patch.object(assembler, "STUDIO_ROOT", base), \
                    patch.object(assembler.subprocess, "check_output", return_value="main\n"), \
                    patch.object(assembler.shutil, "rmtree") as remove:
                with self.assertRaisesRegex(RuntimeError, "non-contract branch"):
                    assembler.assemble()
                remove.assert_not_called()

    def test_contract_bootstrap_allows_lan_on_nonproduction_port(self):
        bootstrap = load("contract_bootstrap", ROOT / "android/app/src/main/python/bootstrap.py")
        with patch.object(bootstrap.os.path, "isfile", return_value=True), \
                patch.object(bootstrap.os, "chdir"), patch.object(bootstrap.runpy, "run_path") as run, \
                patch.object(bootstrap.sys, "argv", []), patch.dict(os.environ), \
                patch.dict(bootstrap.sys.modules, {"study_android_library": SimpleNamespace(prepare_initial_library=lambda root: {"initialized": False, "reason": "fixture"})}):
            bootstrap.main(str(ROOT), True, 18033)
            self.assertEqual("0.0.0.0", bootstrap.sys.argv[2])
            self.assertEqual("18033", bootstrap.sys.argv[4])
            self.assertIn("--trusted-lan-write", bootstrap.sys.argv)
            self.assertEqual("contract-v2", os.environ["STUDY_RUNTIME_PROFILE"])
            run.assert_called_once()

    def test_default_bootstrap_keeps_existing_port(self):
        bootstrap = load("normal_bootstrap", ROOT / "android/app/src/main/python/bootstrap.py")
        with patch.object(bootstrap.os.path, "isfile", return_value=True), \
                patch.object(bootstrap.os, "chdir"), patch.object(bootstrap.runpy, "run_path"), \
                patch.object(bootstrap.sys, "argv", []), patch.dict(os.environ), \
                patch.dict(bootstrap.sys.modules, {"study_android_library": SimpleNamespace(prepare_initial_library=lambda root: {"initialized": False, "reason": "fixture"})}):
            bootstrap.main(str(ROOT))
            self.assertEqual("0.0.0.0", bootstrap.sys.argv[2])
            self.assertEqual("8033", bootstrap.sys.argv[4])
            self.assertEqual("android", os.environ["STUDY_RUNTIME_PROFILE"])


if __name__ == "__main__":
    unittest.main()
