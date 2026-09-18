-- Data backfill for dual-role nodes (columns added by db.py migration).

UPDATE study_node
SET role = 'topic',
    answer_md = COALESCE(
      NULLIF(answer_md, ''),
      (
        SELECT c.back
        FROM study_card c
        WHERE c.node_id = study_node.id
          AND c.status = 'active'
        ORDER BY c.created_at, c.id
        LIMIT 1
      ),
      ''
    )
WHERE role = 'outline'
  AND id IN (SELECT DISTINCT node_id FROM study_card WHERE status = 'active');
