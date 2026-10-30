"""Content interoperability and post-SQL selection in disposable libraries."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'study-kb' / 'tools'))
sys.path.append(str(ROOT / '3dStudio' / '3dworkbench' / 'python'))
sys.path.append(str(ROOT / '3dStudio' / 'tools'))
from study_kb import open_db
from plugin_data_authoring import TEMPLATES, bind, write_data
from workbench_plugins import ensure_storage, save_config
from study_sql_configs import sql_review
from study_review_engine import grade_session, get_review_session, end_review_session
from study_selection import normalize, select
from study_review_units import register_session


class ContentSelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'content.sqlite'
        self.con = open_db(self.path)
        self.addCleanup(self.con.close)
        ensure_storage(self.con)
        self.con.commit()
        for module in ('study_sql_configs', 'study_review_engine'):
            p = patch(module + '.open_db', lambda: open_db(self.path))
            p.start(); self.addCleanup(p.stop)
        with self.con:
            self.con.execute('BEGIN IMMEDIATE')
            self.created = write_data(self.con, TEMPLATES['review-basic/v1'], 'study.review-table', 'reviews', {
                'name': '共享机械知识', 'request_id': 'content-selection-create-001',
                'rows': [{'card_id': str(i), 'question': 'Question ' + str(i), 'answer': 'Answer', 'hint': 'Hint'} for i in range(8)], 'settings': {}}, create=True)
        self.config = self.created['config']
        self.table = self.config['settings']['dataSource']['table']

    def configure(self, policy):
        with self.con:
            self.config = save_config(self.con, 'study.review-table', 'reviews', {**self.config, 'settings': {**self.config['settings'], 'selectionPolicy': policy}})

    def test_runtime_adapter_units_match_package_declarations(self):
        """Exercise real adapters, then compare persisted slots to manifests."""
        from plugin_units import register_config, reconcile
        from study_time_resources import ensure_plugin_resources

        with self.con:
            register_config(self.con, self.config)
            tree = save_config(self.con, 'study.node-tree', 'trees', {
                'name': 'Tree binding', 'sql': 'SELECT id,parent_id,title,content_md FROM "' + self.table + '"',
                'contract_version': 'tree-nodes/v1', 'parameters': {}, 'settings': {}})
            register_config(self.con, tree)
            trigger_sql = 'CREATE TRIGGER content_fixture AFTER UPDATE ON "' + self.table + '" BEGIN SELECT NEW.id; END'
            draft = save_config(self.con, 'official.sqlite-triggers', 'triggers', {
                'name': 'Trigger draft', 'sql': trigger_sql, 'contract_version': 'sqlite-trigger/v1', 'parameters': {}, 'settings': {}})
            register_config(self.con, draft)
            self.con.execute(trigger_sql)
            for plugin in ('study.pomodoro', 'study.stopwatch'):
                ensure_plugin_resources(self.con, plugin)
            self.con.execute("INSERT OR REPLACE INTO app_setting(key,value) VALUES ('workbench.metric_definitions.v1','[]')")
            with patch('plugin_units.METRIC_PLUGIN_ID', 'study.metrics'), patch('workbench_api._metric_definition_catalog', return_value={
                'fixture': {'label': 'Fixture count', 'sql': 'SELECT COUNT(*) AS value FROM "' + self.table + '"'}}):
                reconcile(self.con)
        sql_review({'config_id': self.config['id']})
        manifest_paths = list((ROOT / 'study-kb/plugins').glob('*/plugin.json'))
        manifest_paths.append(ROOT / '3dStudio/3dworkbench/plugins/official/sqlite-triggers/plugin.json')
        manifests = {item['id']: item for item in (json.loads(path.read_text(encoding='utf-8')) for path in manifest_paths)}
        seen = set()
        for row in self.con.execute('''SELECT u.id,u.unit_type,i.plugin_id FROM wb_plugin_unit u
                JOIN wb_unit_installation i ON i.id=u.installation_id WHERE u.status='active' '''):
            plugin, kind = row['plugin_id'], row['unit_type']
            types = {item['id']: item for item in manifests[plugin]['contributes'].get('unitTypes', [])}
            self.assertIn(kind, types, (plugin, kind))
            inputs = {item['id']: item for item in types[kind]['dataInputs']}
            for binding in self.con.execute('SELECT * FROM wb_unit_binding WHERE unit_id=?', (row['id'],)):
                self.assertIn(binding['input_slot'], inputs, (plugin, kind, binding['input_slot']))
                declared = inputs[binding['input_slot']]
                self.assertEqual(binding['access'], declared['access'], (plugin, kind))
                if binding['contract'] is not None:
                    self.assertEqual(binding['contract'], declared['contract'], (plugin, kind))
            seen.add((plugin, kind))
        self.assertTrue({('study.node-tree', 'trees-plan'), ('study.review-table', 'reviews-plan'),
            ('study.review-table', 'review-session'), ('study.pomodoro', 'timer-default'),
            ('study.stopwatch', 'timer-default'), ('study.metrics', 'metric-definition'),
            ('official.sqlite-triggers', 'triggers-plan'), ('official.sqlite-triggers', 'trigger-definition')} <= seen)

    def test_full_candidates_are_sorted_before_round_limit(self):
        with self.con:
            for i in range(8):
                self.con.execute('UPDATE workbench_content_learning SET mastery_score=? WHERE collection_id=? AND item_id=?', (100-i*10, self.created['collection_id'], str(i)))
        self.configure({'order': 'weakest', 'limit': 2})
        preview = sql_review({'config_id': self.config['id']}, preview=True)
        self.assertEqual(8, preview['matched'])
        self.assertEqual(['7', '6'], [item['key'] for item in preview['sample']])
        self.assertEqual(8, len(preview['rows']))
        session = sql_review({'config_id': self.config['id'], 'selected_keys': [row['card_id'] for row in preview['rows']], 'preview_hash': preview['preview_hash'], 'selection_seed': preview['selection_seed']})
        self.assertEqual((2, '7'), (session['total'], session['card']['key']))

    def test_random_preview_start_and_resume_share_seeded_order(self):
        self.configure({'order': 'random', 'limit': 8})
        payload = {'config_id': self.config['id'], 'selection_seed': 'repeatable-seed'}
        preview = sql_review(payload, preview=True)
        self.assertEqual(preview, sql_review(payload, preview=True))
        session = sql_review({**payload, 'selected_keys': [row['card_id'] for row in preview['rows']], 'preview_hash': preview['preview_hash']})
        order = [json.loads(row[0])['key'] for row in self.con.execute('SELECT item_json FROM study_knowledge_review_session_item WHERE session_id=? ORDER BY position', (session['session_id'],))]
        self.assertEqual([row['card_id'] for row in preview['rows']], order)
        self.assertEqual(session, get_review_session(session['session_id']))

    def test_learning_change_invalidates_preview(self):
        preview = sql_review({'config_id': self.config['id']}, preview=True)
        with self.con:
            self.con.execute('UPDATE workbench_content_learning SET mastery_score=50,revision=revision+1 WHERE item_id=?', ('0',))
        with self.assertRaisesRegex(ValueError, '变化'):
            sql_review({'config_id': self.config['id'], 'selected_keys': ['0'], 'preview_hash': preview['preview_hash']})

    def test_tree_projection_and_edit_preserve_mastery_and_hidden_parent(self):
        with self.con:
            self.con.execute('UPDATE "' + self.table + '" SET parent_id=? WHERE id=?', ('0', '1'))
        tree = bind(self.con, TEMPLATES['tree-basic/v1'], {'source': {'name': self.table, 'mapping': {'node_id': 'id', 'parent_id': 'parent_id', 'title': 'title', 'content_md': 'content_md'}}})
        self.assertEqual(8, len(self.con.execute(tree['sql']).fetchall()))
        session = sql_review({'config_id': self.config['id']})
        graded = grade_session(session_id=session['session_id'], position=0, rating=4)
        self.assertEqual(25, graded['graded']['mastery_score'])
        with self.con:
            self.con.execute('BEGIN IMMEDIATE')
            update = write_data(self.con, TEMPLATES['review-basic/v1'], 'study.review-table', 'reviews', {**self.config, 'request_id': 'content-selection-edit-001', 'collection_id': self.created['collection_id'], 'data_revision': 1, 'rows': [{'card_id': '1', 'question': 'Edited', 'answer': 'A', 'hint': 'H'}]}, create=False)
        self.assertEqual('0', self.con.execute('SELECT parent_id FROM "' + self.table + '" WHERE id=?', ('1',)).fetchone()[0])
        self.assertEqual(8, self.con.execute('SELECT COUNT(*) FROM "' + self.table + '"').fetchone()[0])
        self.assertEqual(25, self.con.execute('SELECT mastery_score FROM workbench_content_learning WHERE collection_id=? AND item_id=?', (self.created['collection_id'], session['card']['key'])).fetchone()[0])
        self.assertEqual('Edited', next(row for row in self.con.execute(tree['sql']) if row['id'] == '1')['title'])
        repeated = grade_session(session_id=session['session_id'], position=0, rating=4)
        self.assertTrue(repeated['replayed'])
        self.assertEqual(25, repeated['graded']['mastery_score'])

    def test_end_round_releases_durable_refs_without_deleting_history(self):
        session = sql_review({'config_id': self.config['id']})
        unit = self.con.execute("SELECT id FROM wb_plugin_unit WHERE unit_type='review-session' AND legacy_ref=?", (session['session_id'],)).fetchone()[0]
        self.assertGreater(self.con.execute('SELECT COUNT(*) FROM wb_unit_binding WHERE unit_id=?', (unit,)).fetchone()[0], 0)
        result = end_review_session(session['session_id'])
        self.assertTrue(result['ended'])
        self.assertEqual(0, self.con.execute('SELECT COUNT(*) FROM wb_unit_binding WHERE unit_id=?', (unit,)).fetchone()[0])
        self.assertEqual(8, self.con.execute('SELECT COUNT(*) FROM study_knowledge_review_session_item WHERE session_id=?', (session['session_id'],)).fetchone()[0])
        with self.assertRaisesRegex(ValueError, '归档'):
            grade_session(session_id=session['session_id'], position=0, rating=3)

    def test_different_plans_order_same_content_without_writing_fixed_order(self):
        items = [{'key': 'a', 'mastery_score': 80, 'created_at': '2020-01-01'}, {'key': 'b', 'mastery_score': 10, 'created_at': '2021-01-01'}]
        self.assertEqual('a', select(items, normalize({'order': 'created_asc'}), 's')[0][0]['key'])
        self.assertEqual('b', select(items, normalize({'order': 'weakest'}), 's')[0][0]['key'])
        self.assertEqual('a', items[0]['key'])

    def test_dates_compare_instants_and_multilevel_rules_have_stable_nulls(self):
        items = [{'key': 'early', 'created_at': '2026-01-01T01:00:00+03:00', 'mastery_score': 50}, {'key': 'late', 'created_at': '2025-12-31T23:00:00+00:00', 'mastery_score': 50}, {'key': 'unknown', 'created_at': None, 'mastery_score': 50}]
        policy = normalize({'rules': [{'field': 'mastery_score', 'direction': 'asc'}, {'field': 'created_at', 'direction': 'asc', 'nulls': 'last'}]})
        self.assertEqual(['early', 'late', 'unknown'], [item['key'] for item in select(items, policy, 'seed')[0]])
        for value in (float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                normalize({'filters': [{'field': 'mastery_score', 'op': 'lte', 'value': value}]})

    def test_archived_registration_is_idempotent_and_new_round_is_active(self):
        session = sql_review({'config_id': self.config['id']})
        archived = end_review_session(session['session_id'])
        before = [tuple(row) for row in self.con.execute('SELECT id,status,revision FROM wb_plugin_unit ORDER BY id')]
        with self.con:
            register_session(self.con, session['session_id'], archived['config'], active=False)
        self.assertEqual(before, [tuple(row) for row in self.con.execute('SELECT id,status,revision FROM wb_plugin_unit ORDER BY id')])
        new = sql_review({'source_session_id': session['session_id']})
        self.assertNotIn('ended_at', new['config'])
        self.assertEqual(1, grade_session(session_id=new['session_id'], position=0, rating=3)['next']['completed'])

    def test_explicit_row_deletion_waits_for_active_round_and_then_can_proceed(self):
        session = sql_review({'config_id': self.config['id']})
        payload = {**self.config, 'collection_id': self.created['collection_id'], 'data_revision': 1, 'request_id': 'content-delete-active-row-001', 'rows': [], 'deleted_ids': [session['card']['key']]}
        with self.assertRaisesRegex(ValueError, '未完成'):
            with self.con:
                self.con.execute('BEGIN IMMEDIATE')
                write_data(self.con, TEMPLATES['review-basic/v1'], 'study.review-table', 'reviews', payload, create=False)
        end_review_session(session['session_id'])
        with self.con:
            self.con.execute('BEGIN IMMEDIATE')
            write_data(self.con, TEMPLATES['review-basic/v1'], 'study.review-table', 'reviews', payload, create=False)
        self.assertEqual(7, self.con.execute('SELECT COUNT(*) FROM "' + self.table + '"').fetchone()[0])


if __name__ == '__main__':
    unittest.main()
