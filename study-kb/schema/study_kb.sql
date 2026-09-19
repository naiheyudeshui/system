-- Study knowledge base: tree nodes, scopes, cards, FSRS scheduling, review log.
-- Applied by study-kb/tools/db.py on connect.

CREATE TABLE IF NOT EXISTS study_node (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES study_node(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('book', 'chapter', 'section', 'topic', 'group')),
  title TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_study_node_parent_sort
  ON study_node(parent_id, sort_order, title);

CREATE TABLE IF NOT EXISTS study_scope (
  id TEXT PRIMARY KEY,
  anchor_node_id TEXT NOT NULL REFERENCES study_node(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_study_scope_anchor
  ON study_scope(anchor_node_id);

CREATE TABLE IF NOT EXISTS study_card (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES study_node(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  card_type TEXT NOT NULL DEFAULT 'basic'
    CHECK (card_type IN ('basic', 'reverse', 'cloze')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_study_card_node_status
  ON study_card(node_id, status);

CREATE TABLE IF NOT EXISTS study_card_fsrs (
  card_id TEXT PRIMARY KEY REFERENCES study_card(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_study_card_fsrs_due
  ON study_card_fsrs(due_at);

CREATE TABLE IF NOT EXISTS study_review_log (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES study_card(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  elapsed_ms INTEGER,
  before_state_json TEXT NOT NULL DEFAULT '{}',
  after_state_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_study_review_log_card_time
  ON study_review_log(card_id, reviewed_at);

CREATE TABLE IF NOT EXISTS study_review_session (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS study_review_session_item (
  session_id TEXT NOT NULL REFERENCES study_review_session(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  result_json TEXT,
  PRIMARY KEY (session_id, position)
);
