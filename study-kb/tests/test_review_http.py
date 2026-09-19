from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


class ReviewHttpTests(unittest.TestCase):
    @unittest.skipUnless((Path(__file__).resolve().parents[2] / "3dStudio" / "tools").is_dir(), "3dStudio host is not installed")
    def test_real_host_routes_with_isolated_database(self):
        script = textwrap.dedent('''
            import json
            import sys
            import threading
            import urllib.error
            import urllib.request
            from http.server import ThreadingHTTPServer
            from pathlib import Path

            root = Path.cwd()
            sys.path.insert(0, str(root / 'study-kb' / 'tools'))
            from study_kb import open_db, create_node, create_card
            path = Path(sys.argv[1])
            import db
            db.DB_PATH = path
            con = open_db(path)
            node = create_node(con, title='HTTP fixture', kind='book')
            create_card(con, node_id=node['id'], front='HTTP question', back='HTTP answer', due_at='2099-01-01 00:00:00')
            con.commit()
            con.close()

            import serve_workbench
            serve_workbench.STUDY_DB = path
            serve_workbench._install_db_shim()
            serve_workbench._install_workbench_study_shim()
            import study_workbench_patch
            study_workbench_patch.install()
            import workbench_server
            BaseHandler = workbench_server.make_handler(root / 'study-kb' / 'web')
            class Handler(BaseHandler):
                def require_external_write_auth(self):
                    if self.headers.get('X-Test-External'):
                        self.client_address = ('192.0.2.1', self.client_address[1])
                    return super().require_external_write_auth()
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_address[1])
            def request(route, payload=None, expected=200, external=False):
                data = json.dumps(payload).encode() if payload is not None else None
                headers = {'Content-Type': 'application/json'}
                if external:
                    headers['X-Test-External'] = '1'
                req = urllib.request.Request(base + route, data=data, headers=headers)
                try:
                    response = urllib.request.urlopen(req, timeout=10)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    assert response.status == expected, (response.status, response.read())
                    return json.loads(response.read())
            try:
                catalog = request('/api/study/review/catalog')
                assert any(view['name'] == 'v_study_node_cards' for view in catalog['views'])
                layout = request('/api/plugin/layout')
                assert 'study.review-table' in layout['groups']['top']
                assert 'study.node-tree' in layout['groups']['top']
                updated_layout = request('/api/plugin/layout', layout)
                request('/api/plugin/layout', layout, expected=409)
                saved_configs = request('/api/plugin/configs?plugin_id=study.review-table&module_id=reviews')['configs']
                assert len(saved_configs) == 2
                chapters = next(item for item in saved_configs if item['name'] == '章节卡片')
                sql_preview = request('/api/study/review/sql-preview', {'config_id': chapters['id'], 'parameters': {'node_id': None}})
                assert sql_preview['selected'] == 1
                assert len(sql_preview['rows']) == 1
                key = sql_preview['rows'][0]['card_id']
                selection = {'config_id': chapters['id'], 'parameters': {'node_id': None}, 'selected_keys': [key], 'preview_hash': sql_preview['preview_hash']}
                assert request('/api/study/review/sql-session', selection)['total'] == 1
                request('/api/study/review/sql-session', {**selection, 'selected_keys': []}, expected=400)
                request('/api/study/review/sql-session', {**selection, 'selected_keys': ['not-a-card']}, expected=400)
                request('/api/study/review/sql-session', {**selection, 'selected_keys': [key, key]}, expected=400)
                request('/api/study/review/sql-session', {**selection, 'preview_hash': 'stale'}, expected=400)
                sql_state = request('/api/study/review/sql-session', {'config_id': chapters['id'], 'parameters': {'node_id': None}})
                assert sql_state['card']['front'] == 'HTTP question'
                changed = request('/api/plugin/config/save', {**chapters, 'name': 'Changed'})
                request('/api/plugin/config/save', chapters, expected=409)
                request('/api/study/review/sql-session', selection, expected=400)
                assert request('/api/study/review/session/' + sql_state['session_id'])['card']['front'] == 'HTTP question'
                sql_grade = {'session_id': sql_state['session_id'], 'position': 0, 'rating': 3}
                assert request('/api/study/review/session-grade', sql_grade)['next']['completed'] == 1
                assert request('/api/study/review/session-grade', sql_grade)['replayed']
                request('/api/plugin/config/preview', {**changed, 'sql': 'DELETE FROM study_card'}, expected=400)
                request('/api/plugin/config/delete', changed)
                remaining = request('/api/plugin/configs?plugin_id=study.review-table&module_id=reviews')['configs']
                assert len(remaining) == 1
                request('/api/study/review/sql-preview', {'config_id': chapters['id']}, expected=400)
                request('/api/plugin/config/restore', {'plugin_id': 'study.review-table', 'module_id': 'reviews'})
                assert len(request('/api/plugin/configs?plugin_id=study.review-table&module_id=reviews')['configs']) == 2
                tree_configs = request('/api/plugin/configs?plugin_id=study.node-tree&module_id=trees')['configs']
                tree = request('/api/study/tree?config_id=' + tree_configs[0]['id'])
                assert tree['node_count'] == 2
                unified = request('/api/study/tree?model=knowledge')
                assert unified['node_count'] == 2
                assert any(row['title'] == 'HTTP question' and row['content_md'] == 'HTTP answer' for row in unified['rows'])
                assert tree['validation']['valid']
                custom_tree = request('/api/plugin/config/save', {'plugin_id': 'study.node-tree', 'module_id': 'trees', 'name': 'Mapped tree', 'sql': "SELECT 'a' AS code, NULL AS owner, 'Root' AS label, '**Details**' AS body UNION ALL SELECT 'b','a','Child','More'", 'settings': {'tree': {'id': 'code', 'parent': 'owner', 'title': 'label', 'details': [{'column': 'body', 'label': 'Text', 'format': 'markdown'}]}}})
                mapped = request('/api/study/tree?config_id=' + custom_tree['id'])
                assert mapped['roots'][0]['children'][0]['id'] == 'b'
                assert mapped['rows'][0]['detail_1'] == '**Details**'
                request('/api/plugin/config/save', {**custom_tree, 'sql': "SELECT 'a' AS code, 'missing' AS owner, 'Root' AS label, 'Body' AS body"}, expected=400)
                request('/api/plugin/config/preview', {**custom_tree, 'sql': "SELECT 'a' AS code, 'a' AS owner, 'Root' AS label, 'Body' AS body"}, expected=400)
                orphan = request('/api/plugin/config/preview', {**custom_tree, 'sql': "SELECT 'a' AS code, 'missing' AS owner, 'Root' AS label, 'Body' AS body", 'settings': {'tree': {**custom_tree['settings']['tree'], 'orphans': 'root'}}})
                assert orphan['validation']['warnings']
                request('/api/plugin/config/save', {'plugin_id': 'study.node-tree', 'module_id': 'trees', 'name': 'Invalid beyond first page', 'sql': "WITH RECURSIVE nodes(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM nodes WHERE id<250) SELECT id AS node_id, CASE WHEN id=230 THEN id ELSE NULL END AS parent_id, 'Node' AS title FROM nodes"}, expected=400)
                assert not any(item['id'] == 'official.metrics' for item in request('/api/plugins')['plugins'])
                request('/api/plugin/configs?plugin_id=official.metrics&module_id=metrics', expected=400)
                trigger = request('/api/plugin/config/save', {'plugin_id': 'official.sqlite-triggers', 'module_id': 'triggers', 'name': 'Test trigger', 'sql': 'CREATE TRIGGER trg_test_sql AFTER INSERT ON study_node BEGIN SELECT 1; END'})
                assert not any(item['name'] == 'trg_test_sql' for item in request('/api/triggers')['triggers'])
                request('/api/plugin/config/apply', trigger)
                assert any(item['name'] == 'trg_test_sql' for item in request('/api/triggers')['triggers'])
                request('/api/plugin/state', {'plugin_id': 'official.sqlite-triggers', 'state': 'disabled'})
                request('/api/plugin/configs?plugin_id=official.sqlite-triggers&module_id=triggers', expected=400)
                request('/api/plugin/state', {'plugin_id': 'official.sqlite-triggers', 'state': 'enabled'})
                with urllib.request.urlopen(base + '/api/plugin/icon/study.node-tree', timeout=10) as response:
                    assert 'sandbox' in response.headers['Content-Security-Policy']
                    assert b'<svg' in response.read()
                config = {'view': 'v_study_node_cards', 'mapping': {'key': 'card_id', 'front': 'front', 'back': 'back'}, 'mode': 'all'}
                retired_request = urllib.request.Request(base + '/api/study/review/import-legacy', data=b'{}', headers={'Content-Type': 'application/json'})
                try:
                    urllib.request.urlopen(retired_request, timeout=10).close()
                    raise AssertionError('Removed migration endpoint still exists')
                except urllib.error.HTTPError as error:
                    with error:
                        assert error.code == 404
                preview = request('/api/study/review/preview', {'config': config})
                assert preview['selected'] == 1
                request('/api/study/review/session', {'config': config}, expected=403, external=True)
                state = request('/api/study/review/session', {'config': config})
                assert state['total'] == 1
                resumed = request('/api/study/review/session/' + state['session_id'])
                assert resumed['card']['front'] == 'HTTP question'
                grade = {'session_id': state['session_id'], 'position': 0, 'rating': 3}
                result = request('/api/study/review/session-grade', grade)
                assert result['next']['completed'] == 1
                assert result['graded']['due_at'] != '2099-01-01 00:00:00'
                assert request('/api/study/review/session-grade', grade)['replayed']
                request('/api/study/review/session', {'config': {**config, 'view': 'study_card'}}, expected=400)
                request('/api/study/review/session-grade', {**grade, 'rating': 9}, expected=400)
                request('/api/study/review/session/missing', expected=400)
                request('/api/study/review/next')
                with urllib.request.urlopen(base + '/studyReview.mjs', timeout=10) as response:
                    assert response.status == 200
                    assert b'renderReviewTablePanel' in response.read()
                con = open_db(path)
                try:
                    for index in range(8):
                        create_card(con, node_id=node['id'], front='Extra ' + str(index), back='Answer', due_at='2099-01-01 00:00:00')
                    con.commit()
                finally:
                    con.close()
                current_chapters = next(item for item in request('/api/plugin/configs?plugin_id=study.review-table&module_id=reviews')['configs'] if item['id'] == chapters['id'])
                limited = request('/api/plugin/config/save', {**current_chapters, 'settings': {**current_chapters['settings'], 'limit': 2}})
                complete = request('/api/study/review/sql-preview', {'config_id': chapters['id']})
                assert len(complete['rows']) == 9 and complete['selected'] == 2
                assert complete['rows'][0]['node_path'] == 'HTTP fixture'
                subset = [row['card_id'] for row in complete['rows'][-3:]]
                selected_state = request('/api/study/review/sql-session', {'config_id': chapters['id'], 'selected_keys': subset, 'preview_hash': complete['preview_hash']})
                assert selected_state['total'] == 2 and selected_state['card']['key'] in subset
                con = open_db(path)
                try:
                    con.execute('UPDATE study_card SET back=? WHERE id=?', ('Changed after preview', subset[0]))
                    con.commit()
                finally:
                    con.close()
                request('/api/study/review/sql-session', {'config_id': chapters['id'], 'selected_keys': subset, 'preview_hash': complete['preview_hash']}, expected=400)
                knowledge_key = 'node:' + node['id']
                request('/api/study/knowledge/read', {'node_id': knowledge_key}, expected=403, external=True)
                knowledge = request('/api/study/knowledge/read', {'node_id': knowledge_key})
                edit_payload = {'node_id': knowledge_key, 'version': knowledge['version'], 'request_id': 'http-edit-content', 'operation': 'content', 'content_md': '**Edited**'}
                request('/api/study/knowledge/save', edit_payload, expected=403, external=True)
                edited = request('/api/study/knowledge/save', edit_payload)
                assert edited['node']['content_md'] == '**Edited**'
                assert request('/api/study/knowledge/save', edit_payload) == edited
                request('/api/study/knowledge/save', {**edit_payload, 'request_id': 'http-stale-edit'}, expected=409)
                created = request('/api/study/knowledge/save', {'node_id': knowledge_key, 'version': edited['version'], 'request_id': 'http-create-topic', 'operation': 'child', 'title': 'New child', 'content_md': ''})
                assert created['node']['parent_id'] == knowledge_key
                assert any(row['title'] == 'New child' for row in request('/api/study/tree?model=knowledge')['rows'])
                print('HTTP integration passed')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
        ''')
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-u", "-c", script, str(Path(directory) / "http.sqlite")],
                cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=45,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("HTTP integration passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
