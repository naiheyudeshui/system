"""Durable references held by unfinished review snapshots."""
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[2] / '3dStudio' / '3dworkbench' / 'python'))
from plugin_units import ensure_unit, bind_objects, deactivate_unit, query_dependencies, register_config, config_workspace


def register_session(con, session_id, config, active=True):
    if not active and con.execute("SELECT 1 FROM sqlite_master WHERE name='wb_plugin_unit'").fetchone():
        previous = con.execute("SELECT id,status FROM wb_plugin_unit WHERE unit_type='review-session' AND legacy_ref=?", (session_id,)).fetchone()
        if previous and previous['status'] == 'deleted':
            return dict(previous)
    parent = None
    workspace_id = "default"
    if config.get('config_id'):
        saved = con.execute('SELECT * FROM workbench_plugin_config WHERE id=? AND deleted=0', (config['config_id'],)).fetchone()
        if saved:
            parent = register_config(con, dict(saved))['id']
            workspace_id = config_workspace(con, saved['id'])
    unit = ensure_unit(con, 'study.review-table', 'review-session', session_id, '复习轮次 ' + session_id[:8], parent_unit_id=parent, workspace_id=workspace_id)
    if not active:
        deactivate_unit(con, unit['id'])
        return unit
    source = config.get('sql') or ('SELECT * FROM "' + config['view'].replace('"', '""') + '"')
    bind_objects(con, unit['id'], 'content', query_dependencies(con, source, config.get('parameters')), query=source, contract='review-cards/v1')
    scheduler = config['scheduler']
    resources = [scheduler['table']]
    if con.execute("SELECT 1 FROM sqlite_master WHERE name='workbench_content_learning'").fetchone():
        resources.append('workbench_content_learning')
    bind_objects(con, unit['id'], 'learning', resources, access='read-write')
    return unit
