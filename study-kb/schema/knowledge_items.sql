CREATE TABLE IF NOT EXISTS study_knowledge_item (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('chapter','topic','card')),
  parent_id TEXT REFERENCES study_knowledge_item(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  card_type TEXT,
  hint TEXT NOT NULL DEFAULT '',
  legacy_node_id TEXT UNIQUE,
  legacy_card_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((item_type = 'card' AND legacy_card_id IS NOT NULL AND card_type IS NOT NULL) OR (item_type <> 'card' AND legacy_card_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_study_knowledge_item_parent_sort
  ON study_knowledge_item(parent_id, sort_order, title, id);
CREATE INDEX IF NOT EXISTS idx_study_knowledge_item_card
  ON study_knowledge_item(legacy_card_id);

CREATE TABLE IF NOT EXISTS study_knowledge_schedule (
  item_id TEXT PRIMARY KEY REFERENCES study_knowledge_item(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_study_knowledge_schedule_due ON study_knowledge_schedule(due_at);

CREATE TABLE IF NOT EXISTS study_knowledge_review_log (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES study_knowledge_item(id) ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  elapsed_ms INTEGER,
  before_state_json TEXT NOT NULL DEFAULT '{}',
  after_state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_study_knowledge_review_item_time
  ON study_knowledge_review_log(item_id, reviewed_at);

CREATE TABLE IF NOT EXISTS study_knowledge_scope (
  id TEXT PRIMARY KEY,
  anchor_item_id TEXT NOT NULL REFERENCES study_knowledge_item(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_study_knowledge_scope_anchor ON study_knowledge_scope(anchor_item_id);

CREATE TABLE IF NOT EXISTS study_knowledge_review_session (
  id TEXT PRIMARY KEY, config_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS study_knowledge_review_session_item (
  session_id TEXT NOT NULL REFERENCES study_knowledge_review_session(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, item_json TEXT NOT NULL, result_json TEXT,
  PRIMARY KEY(session_id,position)
);
CREATE TABLE IF NOT EXISTS study_knowledge_edit (
  request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, operation TEXT NOT NULL,
  before_json TEXT NOT NULL, result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
