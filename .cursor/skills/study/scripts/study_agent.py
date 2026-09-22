#!/usr/bin/env python3
"""Read-only inspection and validation for the unified knowledge model."""
from __future__ import annotations
import argparse, hashlib, json, re, sqlite3
from pathlib import Path
from _paths import DEFAULT_DB

def connect_readonly(path: Path):
    if not path.is_file(): raise ValueError(f"study database does not exist: {path}")
    con=sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True); con.row_factory=sqlite3.Row; return con
def rows(con,sql,params=()): return [dict(r) for r in con.execute(sql,params).fetchall()]
def item_id(value): return value if str(value).startswith(('node:','card:')) else 'node:'+str(value)
def path_for(con,node_id):
    result=[]; seen=set(); current=item_id(node_id)
    while current:
        if current in seen: raise ValueError("cycle detected in study_knowledge_item")
        seen.add(current); row=con.execute("SELECT * FROM study_knowledge_item WHERE id=? AND status!='archived'",(current,)).fetchone()
        if row is None: raise ValueError(f"unknown item: {node_id}")
        result.append(dict(row)); current=row['parent_id']
    return list(reversed(result))
def inspect_node(con,node_id):
    key=item_id(node_id); path=path_for(con,key)
    children=rows(con,"SELECT * FROM study_knowledge_item WHERE parent_id=? AND status!='archived' ORDER BY sort_order,title,id",(key,))
    cards=rows(con,"""SELECT i.*,s.due_at,s.stability,s.difficulty,s.reps,s.lapses
      FROM study_knowledge_item i LEFT JOIN study_knowledge_schedule s ON s.item_id=i.id
      WHERE i.item_type='card' AND i.id=? OR i.parent_id=? ORDER BY i.sort_order,i.id""",(key,key))
    scopes=rows(con,"""SELECT s.id,s.label,s.is_default FROM study_knowledge_scope s
      WHERE s.anchor_item_id=? OR EXISTS (SELECT 1 FROM v_study_scope_tree t WHERE t.scope_id=s.id AND t.node_id=?)
      ORDER BY s.is_default DESC,s.label""",(key,key))
    reviews=rows(con,"""SELECT l.item_id AS card_id,l.rating,l.reviewed_at,l.elapsed_ms
      FROM study_knowledge_review_log l JOIN study_knowledge_item i ON i.id=l.item_id
      WHERE i.id=? OR i.parent_id=? ORDER BY l.reviewed_at DESC,l.id DESC LIMIT 20""",(key,key))
    return {'node':path[-1],'path':path,'children':children,'cards':cards,'scopes':scopes,'recent_reviews':reviews}
def validate_draft(con,parent_id,payload):
    if not isinstance(payload,dict): raise ValueError('draft must be an object')
    parent=item_id(parent_id); path=path_for(con,parent); items=payload.get('cards',payload.get('items',[]))
    if not isinstance(items,list): raise ValueError('draft.cards must be a list')
    siblings={r[0].casefold() for r in con.execute('SELECT title FROM study_knowledge_item WHERE parent_id=?',(parent,))}
    errors=[]; warnings=[]; normalized=[]; vague=re.compile(r'^(它|上述|以上|该|这个|这类).{0,20}(是什么|特点|作用|包括|区别)')
    for i,item in enumerate(items):
        if not isinstance(item,dict): errors.append({'index':i,'message':'item must be an object'}); continue
        title=str(item.get('title',item.get('front',''))).strip(); answer=str(item.get('answer_md',item.get('back',''))).strip(); source=str(item.get('source_ref',payload.get('source_ref',''))).strip()
        if not title: errors.append({'index':i,'message':'missing title/front'})
        if not answer: errors.append({'index':i,'message':'missing answer/back'})
        if title.casefold() in siblings: warnings.append({'index':i,'type':'same_sibling_title','title':title})
        if vague.match(title): warnings.append({'index':i,'type':'context_dependent_question','title':title})
        if not source: warnings.append({'index':i,'type':'missing_source'})
        normalized.append({'title':title,'front':str(item.get('front',title)).strip(),'answer_md':answer,'back':str(item.get('back',answer)).strip(),'hint':str(item.get('hint','')),'card_type':str(item.get('card_type','basic')),'source_ref':source})
    return {'valid':not errors,'parent':{'id':parent,'path':path},'count':len(normalized),'errors':errors,'warnings':warnings,'normalized':normalized,'draft_hash':hashlib.sha256(json.dumps(normalized,ensure_ascii=False,sort_keys=True).encode()).hexdigest()}
def coverage(con,root_id=None):
    root=item_id(root_id) if root_id else None; where=''; params=()
    if root: where="WHERE id IN (WITH RECURSIVE s(id) AS (SELECT id FROM study_knowledge_item WHERE id=? UNION ALL SELECT i.id FROM study_knowledge_item i JOIN s ON i.parent_id=s.id) SELECT id FROM s)"; params=(root,)
    totals=con.execute(f"SELECT COUNT(*) nodes,SUM(item_type='topic') topics FROM study_knowledge_item {where}",params).fetchone()
    missing=[]
    return {'root_id':root_id,'nodes':totals['nodes'] or 0,'topics':totals['topics'] or 0,'topics_without_active_card':missing}
def doctor(con):
    return {'integrity_check':con.execute('PRAGMA integrity_check').fetchone()[0],'foreign_key_check':rows(con,'PRAGMA foreign_key_check'),'active_cards_without_schedule':rows(con,"SELECT i.id FROM study_knowledge_item i LEFT JOIN study_knowledge_schedule s ON s.item_id=i.id WHERE i.item_type='card' AND i.status='active' AND s.item_id IS NULL"),'duplicate_sibling_titles':rows(con,"SELECT parent_id,title,COUNT(*) count FROM study_knowledge_item WHERE status='active' GROUP BY parent_id,title HAVING COUNT(*)>1")}
def main(argv=None):
    p=argparse.ArgumentParser(); p.add_argument('--db',type=Path,default=DEFAULT_DB); sub=p.add_subparsers(dest='command',required=True)
    q=sub.add_parser('inspect'); q.add_argument('--node',required=True)
    q=sub.add_parser('validate-draft'); q.add_argument('--parent',required=True); q.add_argument('--input',type=Path,required=True)
    q=sub.add_parser('coverage'); q.add_argument('--root'); sub.add_parser('doctor'); a=p.parse_args(argv); con=connect_readonly(a.db)
    try: result=inspect_node(con,a.node) if a.command=='inspect' else validate_draft(con,a.parent,json.loads(a.input.read_text(encoding='utf-8'))) if a.command=='validate-draft' else coverage(con,a.root) if a.command=='coverage' else doctor(con); print(json.dumps(result,ensure_ascii=False,indent=2)); return 0
    finally: con.close()
if __name__=='__main__': raise SystemExit(main())
