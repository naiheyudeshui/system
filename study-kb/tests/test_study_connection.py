"""Connection identity and configuration tests; never open the live library."""
import json
import io
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".cursor/skills/study/scripts"))
import study_server


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.identity = {"schema": "study.connection/v1", "productId": "study", "runtimeProfile": "contract-v2"}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(owner.identity).encode())
            def log_message(self, *args): pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.identity["serverPort"] = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_validate_then_save_and_read_with_existing_path_resolver(self):
        import _paths
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "server.url"
            result = study_server.configure_server(self.base + "/", "contract-v2", target)
            self.assertEqual("contract-v2", result["identity"]["runtimeProfile"])
            with patch.object(_paths, "_SERVER_URL_FILE", target), patch.dict(_paths.os.environ, {"STUDY_SERVER_URL": ""}):
                self.assertEqual(self.base, _paths.default_server_url())

    def test_wrong_runtime_product_and_port_preserve_previous_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "server.url"; target.write_text("previous", encoding="utf-8")
            for field, value in (("runtimeProfile", "desktop"), ("productId", "other"), ("serverPort", 1)):
                with self.subTest(field=field):
                    original = self.identity[field]; self.identity[field] = value
                    with self.assertRaises(ValueError): study_server.configure_server(self.base, "contract-v2", target)
                    self.assertEqual("previous", target.read_text(encoding="utf-8"))
                    self.identity[field] = original

    def test_reject_non_root_and_credential_urls(self):
        for url in (self.base + "/api", self.base + "?x=1", self.base + "#fragment", "file:///tmp", "http://user:pass@localhost:8033"):
            with self.subTest(url=url), self.assertRaises(ValueError): study_server.connection_identity(url)

    def test_write_cli_requires_explicit_or_configured_profile_before_any_request(self):
        with patch.object(study_server, "_SERVER_URL_FILE", Path("missing-config.url")), \
                patch.dict(study_server.os.environ, {"STUDY_SERVER_URL": ""}), \
                patch.object(study_server, "_request") as call, patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as error:
                study_server.main(["--server", self.base, "save", "--input", "unused.json"])
            self.assertEqual(2, error.exception.code); call.assert_not_called()

    def test_cli_profile_mismatch_stops_before_loading_write_payload(self):
        self.identity["runtimeProfile"] = "desktop"
        with self.assertRaisesRegex(ValueError, "Expected contract-v2"):
            study_server.main(["--server", self.base, "--profile", "contract-v2", "save", "--input", "unused.json"])

    def test_actual_handler_identity_uses_bound_port_without_database_queries(self):
        script = '''
import os, sys, threading
from pathlib import Path
from http.server import ThreadingHTTPServer
root = Path.cwd()
sys.path.insert(0, str(root / 'study-kb/tools'))
sys.path.insert(0, str(root / '.cursor/skills/study/scripts'))
import serve_workbench, study_server
serve_workbench.STUDY_DB = Path(sys.argv[1])
serve_workbench._install_db_shim(); serve_workbench._install_workbench_study_shim()
import study_workbench_patch, workbench_server
study_workbench_patch.install()
server = ThreadingHTTPServer(('127.0.0.1', 0), workbench_server.make_handler(root / 'study-kb/web'))
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    # The handler must not query the DB after startup, even for identity.
    import db
    def forbidden(*args, **kwargs): raise AssertionError('identity opened the database')
    db.connect = forbidden
    for profile in ('desktop', 'android', 'contract-v2'):
        os.environ['STUDY_RUNTIME_PROFILE'] = profile
        identity = study_server.connection_identity(f'http://127.0.0.1:{server.server_port}', profile)
        assert identity['serverPort'] == server.server_port
finally:
    server.shutdown(); server.server_close(); thread.join()
'''
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run([sys.executable, "-c", script, str(Path(temp) / "fixture.sqlite")], cwd=ROOT, text=True, capture_output=True)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__": unittest.main()
