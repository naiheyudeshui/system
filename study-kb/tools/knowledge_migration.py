"""One-time migration helper for databases that still contain the split schema."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def _table_exists(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def migrate(con):
    schema = Path(__file__).resolve().parents[1] / 'schema' / 'knowledge_items.sql'
    con.executescript(schema.read_text(encoding='utf-8'))
    if not _table_exists(con, 'study_node') or not _table_exists(con, 'study_card'):
        return
    con.execute("CREATE TABLE IF NOT EXISTS legacy_study_node_archive AS SELECT * FROM study_node WHERE 0")
    con.execute("CREATE TABLE IF NOT EXISTS legacy_study_card_archive AS SELECT * FROM study_card WHERE 0")
    con.execute("CREATE TABLE IF NOT EXISTS legacy_study_card_fsrs_archive AS SELECT * FROM study_card_fsrs WHERE 0")
    con.execute("CREATE TABLE IF NOT EXISTS legacy_study_review_log_archive AS SELECT * FROM study_review_log WHERE 0")
    if con.execute("SELECT COUNT(*) FROM legacy_study_node_archive").fetchone()[0] == 0:
        con.execute("INSERT INTO legacy_study_node_archive SELECT * FROM study_node")
        con.execute("INSERT INTO legacy_study_card_archive SELECT * FROM study_card")
        con.execute("INSERT INTO legacy_study_card_fsrs_archive SELECT * FROM study_card_fsrs")
        con.execute("INSERT INTO legacy_study_review_log_archive SELECT * FROM study_review_log")
    con.execute("""INSERT OR IGNORE INTO study_knowledge_item
      (id,item_type,parent_id,sort_order,title,content_md,source_ref,status,legacy_node_id,created_at,updated_at)
      SELECT 'node:'||n.id, CASE WHEN n.role='topic' THEN 'topic' ELSE 'chapter' END,
             CASE WHEN n.parent_id IS NULL THEN NULL ELSE 'node:'||n.parent_id END,
             n.sort_order,n.title,COALESCE(n.answer_md,''),n.source_ref,
             CASE WHEN json_extract(n.metadata_json,'$.knowledge_deleted')=1 THEN 'archived' ELSE 'active' END,
             n.id,n.created_at,n.updated_at FROM study_node n""")
    con.execute("""INSERT OR IGNORE INTO study_knowledge_item
      (id,item_type,parent_id,sort_order,title,content_md,source_ref,status,card_type,hint,legacy_card_id,created_at,updated_at)
      SELECT 'card:'||c.id,'card','node:'||c.node_id,
             ROW_NUMBER() OVER (PARTITION BY c.node_id ORDER BY c.created_at,c.id)-1,
             c.front,c.back,c.source_ref,c.status,c.card_type,c.hint,c.id,c.created_at,c.updated_at
      FROM study_card c""")
    con.execute("""INSERT OR IGNORE INTO study_knowledge_schedule
      (item_id,due_at,stability,difficulty,reps,lapses,state_json,updated_at)
      SELECT 'card:'||f.card_id,f.due_at,f.stability,f.difficulty,f.reps,f.lapses,f.state_json,f.updated_at
      FROM study_card_fsrs f
      JOIN study_knowledge_item i ON i.id='card:'||f.card_id""")
    con.execute("""INSERT OR IGNORE INTO study_knowledge_review_log
      (id,item_id,rating,reviewed_at,elapsed_ms,before_state_json,after_state_json)
      SELECT l.id,'card:'||l.card_id,l.rating,l.reviewed_at,l.elapsed_ms,l.before_state_json,l.after_state_json
      FROM study_review_log l
      JOIN study_knowledge_item i ON i.id='card:'||l.card_id""")
    if _table_exists(con, 'study_node_parent_card'):
        con.execute("""UPDATE study_knowledge_item
          SET parent_id=(SELECT 'card:'||parent_card_id FROM study_node_parent_card r WHERE r.node_id=legacy_node_id)
          WHERE legacy_node_id IN (SELECT node_id FROM study_node_parent_card)""")
    con.execute("""INSERT OR IGNORE INTO study_knowledge_scope(id,anchor_item_id,label,is_default,created_at)
      SELECT s.id,'node:'||s.anchor_node_id,s.label,s.is_default,s.created_at FROM study_scope s
      JOIN study_knowledge_item i ON i.id='node:'||s.anchor_node_id""")


def drop_legacy_tables(con):
    for name in ('study_node_parent_card','study_scope','study_card_fsrs','study_review_log','study_review_session_item','study_review_session','study_card','study_node'):
        con.execute(f'DROP TABLE IF EXISTS "{name}"')
