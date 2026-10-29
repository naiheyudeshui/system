"""Run the branch's unchanged backend fixtures, never the installed library.

Android has no executable Python interpreter for CLI subprocesses. Those three
cases are explicitly skipped here and must still pass in desktop verification.
No listener is opened and no production connection is supplied by this module.
"""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

_lock = threading.Lock()
_SUBPROCESS_TESTS = frozenset({
    "test_http_cli_and_direct_query_use_same_handler",
    "test_cli_list_describe_help_and_auth_exit_code",
    "test_cli_preview_mutation_and_confirmation",
})


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(runtime_root: str, cache_root: str) -> str:
    with _lock:
        root = Path(runtime_root).resolve()
        metadata = json.loads((root / "contract-v2-build.json").read_text(encoding="utf-8"))
        studio = root / "3dStudio"
        source = str(studio / "3dworkbench/python")
        if source not in sys.path:
            sys.path.insert(0, source)
        import command_gateway, command_http, command_policy
        import data_binding, data_provisioning, workbench_cli
        # Refuse a stale cached import from another runtime.
        for module in (command_gateway, command_http, command_policy, data_binding,
                       data_provisioning, workbench_cli):
            if Path(module.__file__).resolve().parent != Path(source):
                raise RuntimeError("Unexpected module origin: " + module.__name__)
        cases = _load("contract_android_fixtures", studio / "tests/test_data_platform_v2.py")
        schema = _load("contract_android_schema", studio / "tests/test_data_schema_parity.py")
        loader = unittest.TestLoader()
        suite = unittest.TestSuite()
        for name in loader.getTestCaseNames(cases.DataPlatformTest):
            if name in _SUBPROCESS_TESTS:
                @unittest.skip("Android has no Python CLI subprocess; verified on desktop")
                def skipped(self):
                    pass
                suite.addTest(type("AndroidCliSkip", (unittest.TestCase,), {name: skipped})(name))
            else:
                suite.addTest(cases.DataPlatformTest(name))
        suite.addTests(loader.loadTestsFromTestCase(schema.SchemaParityTest))
        old_temp = tempfile.tempdir
        stream = io.StringIO()
        try:
            with tempfile.TemporaryDirectory(prefix="contract-v2-", dir=cache_root) as temp:
                tempfile.tempdir = temp
                result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        finally:
            tempfile.tempdir = old_temp
        passed = result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped)
        return ("分支：" + metadata["studioBranch"] + "\n"
                "数据：仅临时 fixture，不读写正式知识库\n"
                "结论：" + ("PASS" if result.wasSuccessful() else "FAIL") + "\n"
                f"通过 {passed}，失败 {len(result.failures)}，错误 {len(result.errors)}，跳过 {len(result.skipped)}\n"
                "说明：CLI 子进程三项仅在电脑验证；共享 Schema 项逐条验证包内全部样本。\n\n"
                + stream.getvalue())
