from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "3dStudio" / "3dworkbench" / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from study_kb import open_db
import json

import workbench_plugins
from study_layout import register_study_layout
from workbench_plugins import ConflictError, apply_bsp_layout, bsp_layout_state, configs, delete_config, ensure_storage, query_rows, save_config, seed_configs, validate_result


class WorkbenchPluginsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.con = open_db(Path(self.tmp.name) / "test.sqlite")
        ensure_storage(self.con)
        self.plugins = [
            {"id": "study.review-table", "state": "enabled", "contributes": {"panels": [{"location": "inspector"}]}},
            {"id": "official.table-print", "state": "enabled", "contributes": {"panels": [{"location": "inspector"}]}},
            {"id": "study.metrics", "state": "enabled", "contributes": {"panels": [{"location": "upper"}]}},
            {"id": "study.pomodoro", "state": "enabled", "contributes": {"panels": [{"location": "upper"}]}},
        ]
        for plugin in self.plugins:
            self.con.execute("INSERT INTO workbench_plugin(plugin_id,version,manifest_json,root_path,state) VALUES (?, '1.0.0','{}','.',?)", (plugin["id"], plugin["state"]))
        self.con.commit()

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_study_layout_replaces_retired_core_table_with_catalog_and_grid(self):
        register_study_layout()
        plugins = [{"id": plugin_id, "state": "enabled"} for plugin_id in ("study.table-catalog", "study.table-grid", "study.metrics", "study.pomodoro")]
        legacy = {"groups": {"top": ["core.table"], "upper": ["core.metrics"], "disabled": ["study.pomodoro"]}}
        self.con.execute("INSERT INTO workbench_plugin_layout(id,revision,value) VALUES (1,4,?)", (json.dumps(legacy),))
        state = bsp_layout_state(self.con, plugins)
        leaves = workbench_plugins.validate_bsp_tree(state["tree"], {plugin["id"] for plugin in plugins})
        self.assertTrue(leaves["valid"], leaves["errors"])
        self.assertEqual(["study.table-catalog", "study.table-grid", "study.metrics"], [leaf["pluginId"] for leaf in leaves["leaves"]])
        self.assertEqual(5, state["revision"])
        saved = apply_bsp_layout(self.con, plugins, {"schema": state["schema"], "revision": state["revision"], "tree": state["tree"]})
        with self.assertRaises(ConflictError):
            apply_bsp_layout(self.con, plugins, {"schema": state["schema"], "revision": state["revision"], "tree": state["tree"]})
        self.assertEqual(saved, bsp_layout_state(self.con, plugins))

    def test_queries_reject_writes_multiple_statements_and_dangerous_functions(self):
        for sql in ["DELETE FROM study_card", "SELECT 1; SELECT 2", "PRAGMA user_version", "ATTACH ':memory:' AS other", "SELECT load_extension('bad')", "CREATE TABLE injected (id)"]:
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                query_rows(self.con, sql)
        self.assertEqual(query_rows(self.con, "WITH example AS (SELECT :value AS value) SELECT value FROM example", {"value": "' OR 1=1"})["rows"][0]["value"], "' OR 1=1")
        self.con.execute("INSERT INTO app_setting(key,value) VALUES ('after.query','ok')")

    def test_bounded_query_and_contracts(self):
        result = query_rows(self.con, "WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<10) SELECT * FROM seq", limit=3)
        self.assertTrue(result["truncated"])
        with self.assertRaises(ValueError):
            query_rows(self.con, "WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq) SELECT SUM(value) FROM seq", seconds=0.001)
        with self.assertRaises(ValueError):
            validate_result(query_rows(self.con, "SELECT 'not number' AS value"), "scalar-number/v1")
        validate_result(query_rows(self.con, "SELECT 2 AS value"), "scalar-number/v1")
        with self.assertRaises(ValueError):
            validate_result(query_rows(self.con, "SELECT 1 AS question"), "review-cards/v1")
        with self.assertRaises(ValueError):
            validate_result(query_rows(self.con, "SELECT 1 AS node_id, 1 AS parent_id, 'cycle' AS title"), "tree-nodes/v1")

    def test_config_conflicts_tombstones_and_plugin_isolation(self):
        default = {"id": "default", "name": "Default", "sql": "SELECT 1 AS value"}
        seed_configs(self.con, "plugin.one", "metrics", [default])
        record = configs(self.con, "plugin.one", "metrics")[0]
        updated = save_config(self.con, "plugin.one", "metrics", {**record, "name": "Changed"})
        with self.assertRaises(ConflictError):
            save_config(self.con, "plugin.one", "metrics", record)
        with self.assertRaises(ValueError):
            save_config(self.con, "plugin.two", "metrics", updated)
        delete_config(self.con, "plugin.one", "metrics", updated)
        seed_configs(self.con, "plugin.one", "metrics", [default])
        self.assertEqual(configs(self.con, "plugin.one", "metrics"), [])


if __name__ == "__main__":
    unittest.main()
