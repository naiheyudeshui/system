-- Study-kb workbench dashboard defaults (no 3dStudio sales_order metrics).

INSERT INTO app_setting (key, value) VALUES (
  'workbench.dashboard.v1',
  '{"metrics_visible": true, "inspector_visible": true, "enabled_metrics": ["due_cards", "active_cards", "study_nodes", "review_today"], "custom_metrics": [], "metric_labels": {}, "builtin_metric_sql": {}, "plugin_order": []}'
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
WHERE value LIKE '%open_orders%' OR value LIKE '%sales_order%' OR value LIKE '%active_jobs%';
