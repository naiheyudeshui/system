from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


class StudyTimeHttpTests(unittest.TestCase):
    def test_plugin_layout_and_timer_routes_with_isolated_database(self):
        script = textwrap.dedent("""
            import json
            import sys
            import threading
            import urllib.request
            from http.server import ThreadingHTTPServer
            from pathlib import Path

            root = Path.cwd()
            sys.path.insert(0, str(root / 'study-kb' / 'tools'))
            path = Path(sys.argv[1])
            import db
            db.DB_PATH = path
            db.connect(path).close()

            import serve_workbench
            serve_workbench.STUDY_DB = path
            serve_workbench._install_db_shim()
            serve_workbench._install_workbench_study_shim()
            import study_workbench_patch
            study_workbench_patch.install()
            import workbench_server
            handler = workbench_server.make_handler(root / 'study-kb' / 'web')
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_address[1])

            def request(route, payload=None):
                data = json.dumps(payload).encode() if payload is not None else None
                req = urllib.request.Request(base + route, data=data, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=10) as response:
                    return json.loads(response.read())

            try:
                plugins = {item['id']: item for item in request('/api/plugins')['plugins']}
                layout = request('/api/plugin/layout')
                assert layout['groups']['upper'] == ['study.metrics']
                assert plugins['study.metrics']['state'] == 'enabled'
                assert plugins['study.pomodoro']['state'] == 'disabled'
                assert plugins['study.stopwatch']['state'] == 'disabled'
                assert request('/api/study/time?kind=stopwatch')['current'] is None
                running = request('/api/study/time', {'kind': 'stopwatch', 'action': 'start'})
                assert running['current']['status'] == 'running'
                lap = request('/api/study/time', {'kind': 'stopwatch', 'action': 'lap'})
                assert lap['laps'][0]['lap_number'] == 1
                assert request('/api/study/time', {'kind': 'stopwatch', 'action': 'pause'})['current']['status'] == 'paused'
                assert request('/api/study/time', {'kind': 'stopwatch', 'action': 'resume'})['current']['status'] == 'running'
                assert request('/api/study/time', {'kind': 'stopwatch', 'action': 'pause'})['current']['status'] == 'paused'
                reset = request('/api/study/time', {'kind': 'stopwatch', 'action': 'reset'})
                assert reset['current'] is None
                assert reset['laps'] == []
                print('Timer HTTP integration passed')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
        """)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-u", "-c", script, str(Path(directory) / "http.sqlite")],
                cwd=Path(__file__).resolve().parents[2],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Timer HTTP integration passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
