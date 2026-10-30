"""Project authoritative scheduler facts without fabricating FSRS mastery."""
import sys
import json
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[2] / '3dStudio' / '3dworkbench' / 'python'))
from plugin_learning import facts


def enrich(con, item, scheduler):
    item = dict(item)
    key = item['key']
    if scheduler['kind'] == 'learning':
        table = '"' + scheduler['table'].replace('"', '""') + '"'
        key_col = '"' + scheduler['key'].replace('"', '""') + '"'
        content = con.execute('SELECT created_at,updated_at FROM ' + table + ' WHERE ' + key_col + '=?', (key,)).fetchone()
        if not content:
            return None
        state = facts(con, scheduler['collection_id'], key)
        item.update(state)
        item.update(dict(content))
        item['collection_id'] = scheduler['collection_id']
        if not state.get('learning_enabled'):
            return None
    elif scheduler['kind'] == 'fsrs':
        row = con.execute("SELECT s.*,i.created_at FROM study_knowledge_schedule s JOIN study_knowledge_item i ON i.id=s.item_id WHERE s.item_id=? AND i.status='active'", (key,)).fetchone()
        if not row:
            return None
        row = dict(row)
        last_review = json.loads(row.get('state_json') or '{}').get('last_review')
        item.update(learning_enabled=1, mastery_score=None, review_count=row.get('reps', 0), lapse_count=row.get('lapses', 0), created_at=row.get('created_at'), last_reviewed_at=last_review, due_at=row['due_at'])
        item['state_revision'] = [row.get(name) for name in ('due_at', 'reps', 'lapses', 'stability', 'difficulty', 'last_review')]
    else:
        # Legacy due_at stays in its original column; only additional facts live here.
        identity = 'legacy:' + scheduler['table']
        state = facts(con, identity, key)
        item.update({k: v for k, v in state.items() if k not in {'due_at', 'learning_enabled'}})
        item.update(learning_enabled=state['learning_enabled'] if state['revision'] else 1, collection_id=identity)
        if not item['learning_enabled']:
            return None
        quote = lambda value: '"' + value.replace('"', '""') + '"'
        target = con.execute('SELECT ' + quote(scheduler['due']) + ' FROM ' + quote(scheduler['table']) + ' WHERE ' + quote(scheduler['key']) + '=?', (key,)).fetchone()
        if not target:
            return None
        item['due_at'] = target[0]
    return item
