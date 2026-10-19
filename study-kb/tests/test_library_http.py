from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


class StudyLibraryHttpTests(unittest.TestCase):
    def test_export_and_import_replace_the_live_library(self):
        script = textwrap.dedent("""
            import json
            import sqlite3
            import sys
            import threading
            import urllib.error
            import urllib.request
            from http.server import ThreadingHTTPServer
            from pathlib import Path

            root = Path.cwd()
            sys.path.insert(0, str(root / 'study-kb' / 'tools'))
            path = Path(sys.argv[1])
            import db
            db.DB_PATH = path
            con = db.connect(path)
            con.executescript((root / 'study-kb' / 'schema' / 'study_kb.sql').read_text(encoding='utf-8'))
            con.execute("INSERT INTO study_node(id, kind, title) VALUES ('n1', 'topic', 'Node')")
            con.execute("INSERT INTO study_card(id, node_id, front, back) VALUES ('c1', 'n1', 'original', 'answer')")
            con.commit()
            con.close()

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
                data = payload if isinstance(payload, (bytes, bytearray)) else None
                headers = {'Content-Type': 'application/octet-stream'} if data is not None else {}
                req = urllib.request.Request(base + route, data=data, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=30) as response:
                        return response.status, response.read(), response.headers
                except urllib.error.HTTPError as error:
                    return error.code, error.read(), error.headers

            try:
                plugins = {item['id'] for item in json.load(urllib.request.urlopen(base + '/api/plugins', timeout=30))['plugins']}
                assert 'study.library' in plugins
                status, blob, headers = request('/api/study/library/export')
                assert status == 200, blob
                assert blob.startswith(b'SQLite format 3\\x00')
                assert 'study-' in headers.get('Content-Disposition', '')
                copy = path.with_name('incoming.sqlite')
                copy.write_bytes(blob)
                edit = sqlite3.connect(copy)
                edit.execute("UPDATE study_card SET front='replaced' WHERE id='c1'")
                edit.commit()
                edit.close()
                status, body, _headers = request('/api/study/library/import', copy.read_bytes())
                payload = json.loads(body)
                assert status == 200, payload
                assert payload['ok'] is True
                assert (path.parent / 'backups' / payload['backup']).is_file()
                check = sqlite3.connect(path)
                assert check.execute("SELECT front FROM study_card WHERE id='c1'").fetchone()[0] == 'replaced'
                check.close()
                status, body, _headers = request('/api/study/library/import', b'not a database')
                assert status == 400
                assert 'SQLite' in json.loads(body)['detail']
                check = sqlite3.connect(path)
                assert check.execute("SELECT front FROM study_card WHERE id='c1'").fetchone()[0] == 'replaced'
                check.close()
                knowledge = path.with_name('knowledge.sqlite')
                knowledge.write_bytes(blob)
                know = sqlite3.connect(knowledge)
                know.execute("DROP TABLE IF EXISTS study_card")
                know.commit()
                assert know.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='study_card'").fetchone() is None
                assert know.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='study_knowledge_item'").fetchone() is not None
                know.close()
                status, body, _headers = request('/api/study/library/import', knowledge.read_bytes())
                payload = json.loads(body)
                assert status == 200, payload
                check = sqlite3.connect(path)
                assert check.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='study_knowledge_item'").fetchone() is not None
                check.close()
                print('Library HTTP integration passed')
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
                timeout=60,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Library HTTP integration passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
