-- Study knowledge base views. Applied by study-kb/tools/db.py.

DROP VIEW IF EXISTS v_study_scope_tree;
CREATE VIEW v_study_scope_tree AS
WITH RECURSIVE subtree AS (
  SELECT
    s.id AS scope_id,
    s.label AS scope_label,
    s.is_default AS is_default,
    n.id AS node_id,
    n.parent_id,
    n.kind,
    n.role,
    n.title,
    n.answer_md,
    n.source_ref,
    n.sort_order,
    0 AS depth
  FROM study_scope s
  JOIN study_node n ON n.id = s.anchor_node_id
  UNION ALL
  SELECT
    st.scope_id,
    st.scope_label,
    st.is_default,
    c.id,
    c.parent_id,
    c.kind,
    c.role,
    c.title,
    c.answer_md,
    c.source_ref,
    c.sort_order,
    st.depth + 1
  FROM subtree st
  JOIN study_node c ON c.parent_id = st.node_id
)
SELECT
  scope_id,
  scope_label,
  is_default,
  node_id,
  parent_id,
  kind,
  role,
  title,
  answer_md,
  source_ref,
  sort_order,
  depth,
  (
    SELECT COUNT(*)
    FROM study_card sc
    WHERE sc.node_id = subtree.node_id AND sc.status = 'active'
  ) AS card_count,
  (
    SELECT COUNT(*)
    FROM study_card sc
    JOIN study_card_fsrs f ON f.card_id = sc.id
    WHERE sc.node_id = subtree.node_id
      AND sc.status = 'active'
      AND f.due_at <= datetime('now', 'localtime')
  ) AS due_count,
  (
    SELECT COUNT(*) FROM study_node child WHERE child.parent_id = subtree.node_id
  ) AS child_count
FROM subtree;

DROP VIEW IF EXISTS v_study_mindmap_nodes;
CREATE VIEW v_study_mindmap_nodes AS
SELECT
  n.id,
  n.parent_id,
  n.kind,
  n.role,
  n.title,
  n.answer_md,
  n.source_ref,
  n.sort_order,
  (
    SELECT COUNT(*) FROM study_node child WHERE child.parent_id = n.id
  ) AS child_count,
  (
    SELECT COUNT(*)
    FROM study_card sc
    WHERE sc.node_id = n.id AND sc.status = 'active'
  ) AS card_count,
  (
    SELECT COUNT(*)
    FROM study_card sc
    JOIN study_card_fsrs f ON f.card_id = sc.id
    WHERE sc.node_id = n.id
      AND sc.status = 'active'
      AND f.due_at <= datetime('now', 'localtime')
  ) AS due_count
FROM study_node n;

DROP VIEW IF EXISTS v_study_due_cards;
CREATE VIEW v_study_due_cards AS
SELECT
  c.id AS card_id,
  c.node_id,
  n.title AS node_title,
  n.kind AS node_kind,
  n.role AS node_role,
  n.answer_md,
  c.front,
  c.back,
  c.hint,
  c.card_type,
  c.source_ref,
  f.due_at,
  f.stability,
  f.difficulty,
  f.reps,
  f.lapses
FROM study_card c
JOIN study_node n ON n.id = c.node_id
JOIN study_card_fsrs f ON f.card_id = c.id
WHERE c.status = 'active'
  AND f.due_at <= datetime('now', 'localtime')
ORDER BY f.due_at, c.id;

DROP VIEW IF EXISTS v_study_node_cards;
CREATE VIEW v_study_node_cards AS
SELECT
  c.id AS card_id,
  c.node_id,
  n.title AS node_title,
  n.kind AS node_kind,
  n.role AS node_role,
  n.answer_md,
  c.front,
  c.back,
  c.hint,
  c.card_type,
  c.status,
  c.source_ref,
  f.due_at,
  f.stability,
  f.difficulty,
  f.reps,
  f.lapses
FROM study_card c
JOIN study_node n ON n.id = c.node_id
LEFT JOIN study_card_fsrs f ON f.card_id = c.id
WHERE c.status = 'active'
ORDER BY n.sort_order, n.title, c.created_at, c.id;

DROP VIEW IF EXISTS v_study_review_stats;
CREATE VIEW v_study_review_stats AS
SELECT
  s.id AS scope_id,
  s.label AS scope_label,
  COUNT(DISTINCT sc.id) AS active_cards,
  SUM(CASE WHEN f.due_at <= datetime('now', 'localtime') THEN 1 ELSE 0 END) AS due_now,
  SUM(CASE WHEN date(f.due_at) = date('now', 'localtime') THEN 1 ELSE 0 END) AS due_today,
  ROUND(AVG(f.stability), 2) AS avg_stability,
  ROUND(AVG(f.difficulty), 2) AS avg_difficulty
FROM study_scope s
JOIN v_study_scope_tree t ON t.scope_id = s.id
JOIN study_card sc ON sc.node_id = t.node_id AND sc.status = 'active'
LEFT JOIN study_card_fsrs f ON f.card_id = sc.id
GROUP BY s.id, s.label;
