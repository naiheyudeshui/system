CREATE TABLE IF NOT EXISTS study_node_parent_card (
  node_id TEXT PRIMARY KEY REFERENCES study_node(id) ON DELETE CASCADE,
  parent_card_id TEXT NOT NULL REFERENCES study_card(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_study_node_parent_card ON study_node_parent_card(parent_card_id);
CREATE TABLE IF NOT EXISTS study_knowledge_edit (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
