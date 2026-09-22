-- Runtime views use the unified knowledge item model. Legacy tables are archives only.
DROP VIEW IF EXISTS v_study_scope_tree;
CREATE VIEW v_study_scope_tree AS
WITH RECURSIVE subtree AS (
  SELECT s.id AS scope_id, s.label AS scope_label, s.is_default,
         i.id AS node_id, i.parent_id, i.item_type AS kind, i.item_type AS role,
         i.title, i.content_md AS answer_md, i.source_ref, i.sort_order, 0 AS depth
  FROM study_knowledge_scope s JOIN study_knowledge_item i ON i.id=s.anchor_item_id
  WHERE i.status='active'
  UNION ALL
  SELECT st.scope_id, st.scope_label, st.is_default, c.id, c.parent_id,
         c.item_type, c.item_type, c.title, c.content_md, c.source_ref,
         c.sort_order, st.depth+1
  FROM subtree st JOIN study_knowledge_item c ON c.parent_id=st.node_id
  WHERE c.status='active'
)
SELECT scope_id,scope_label,is_default,node_id,parent_id,kind,role,title,answer_md,source_ref,sort_order,depth,
  (SELECT COUNT(*) FROM study_knowledge_item c WHERE c.parent_id=subtree.node_id AND c.item_type='card' AND c.status='active') AS card_count,
  (SELECT COUNT(*) FROM study_knowledge_item c JOIN study_knowledge_schedule f ON f.item_id=c.id WHERE c.parent_id=subtree.node_id AND c.item_type='card' AND c.status='active' AND f.due_at<=datetime('now','localtime')) AS due_count,
  (SELECT COUNT(*) FROM study_knowledge_item c WHERE c.parent_id=subtree.node_id AND c.status='active') AS child_count
FROM subtree;

DROP VIEW IF EXISTS v_study_mindmap_nodes;
CREATE VIEW v_study_mindmap_nodes AS
SELECT i.id,i.parent_id,i.item_type AS kind,i.item_type AS role,i.title,i.content_md AS answer_md,i.source_ref,i.sort_order,
 (SELECT COUNT(*) FROM study_knowledge_item c WHERE c.parent_id=i.id AND c.status='active') AS child_count,
 (SELECT COUNT(*) FROM study_knowledge_item c WHERE c.parent_id=i.id AND c.item_type='card' AND c.status='active') AS card_count,
 (SELECT COUNT(*) FROM study_knowledge_item c JOIN study_knowledge_schedule f ON f.item_id=c.id WHERE c.parent_id=i.id AND c.item_type='card' AND c.status='active' AND f.due_at<=datetime('now','localtime')) AS due_count
FROM study_knowledge_item i WHERE i.status='active';

DROP VIEW IF EXISTS v_study_due_cards;
CREATE VIEW v_study_due_cards AS
SELECT i.legacy_card_id AS card_id, i.parent_id AS node_id, p.title AS node_title,
       p.item_type AS node_kind, p.item_type AS node_role, p.content_md AS answer_md,
       i.title AS front, i.content_md AS back, i.hint, i.card_type, i.source_ref,
       f.due_at,f.stability,f.difficulty,f.reps,f.lapses
FROM study_knowledge_item i JOIN study_knowledge_item p ON p.id=i.parent_id
JOIN study_knowledge_schedule f ON f.item_id=i.id
WHERE i.item_type='card' AND i.status='active' AND f.due_at<=datetime('now','localtime')
ORDER BY f.due_at,i.id;

DROP VIEW IF EXISTS v_study_node_cards;
CREATE VIEW v_study_node_cards AS
SELECT i.legacy_card_id AS card_id, i.parent_id AS node_id, p.title AS node_title,
       p.item_type AS node_kind, p.item_type AS node_role, p.content_md AS answer_md,
       i.title AS front, i.content_md AS back, i.hint, i.card_type, i.status, i.source_ref,
       f.due_at,f.stability,f.difficulty,f.reps,f.lapses
FROM study_knowledge_item i JOIN study_knowledge_item p ON p.id=i.parent_id
LEFT JOIN study_knowledge_schedule f ON f.item_id=i.id
WHERE i.item_type='card' AND i.status='active'
ORDER BY p.sort_order,p.title,i.sort_order,i.id;

DROP VIEW IF EXISTS v_study_review_stats;
CREATE VIEW v_study_review_stats AS
SELECT s.id AS scope_id,s.label AS scope_label,
 COUNT(DISTINCT i.id) AS active_cards,
 SUM(CASE WHEN f.due_at<=datetime('now','localtime') THEN 1 ELSE 0 END) AS due_now,
 SUM(CASE WHEN date(f.due_at)=date('now','localtime') THEN 1 ELSE 0 END) AS due_today,
 ROUND(AVG(f.stability),2) AS avg_stability,ROUND(AVG(f.difficulty),2) AS avg_difficulty
FROM study_knowledge_scope s JOIN v_study_scope_tree t ON t.scope_id=s.id
JOIN study_knowledge_item i ON i.id=t.node_id AND i.item_type='card' AND i.status='active'
LEFT JOIN study_knowledge_schedule f ON f.item_id=i.id GROUP BY s.id,s.label;

DROP VIEW IF EXISTS v_study_knowledge_nodes;
CREATE VIEW v_study_knowledge_nodes AS
SELECT i.id AS node_id,i.parent_id,i.title,i.content_md,i.content_md AS answer_md,
       CASE WHEN i.item_type='card' THEN 'card' ELSE 'node' END AS source_type,
       COALESCE(i.legacy_node_id,i.legacy_card_id) AS source_id,
       CASE WHEN i.item_type='card' THEN i.parent_id ELSE i.legacy_node_id END AS owner_node_id,
       i.source_ref,i.sort_order,i.status,i.item_type, i.legacy_card_id AS card_id
FROM study_knowledge_item i LEFT JOIN study_knowledge_item p ON p.id=i.parent_id
WHERE i.status='active';
