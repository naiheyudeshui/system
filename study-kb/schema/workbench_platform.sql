-- Minimal 3dworkbench host tables required by workbench_server / plugin_host.

CREATE TABLE IF NOT EXISTS workbench_plugin (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  root_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled', 'disabled', 'error')),
  installed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS workbench_plugin_grant (
  plugin_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0, 1)),
  PRIMARY KEY (plugin_id, capability),
  FOREIGN KEY (plugin_id) REFERENCES workbench_plugin(plugin_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workbench_event_outbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  table_name TEXT,
  record_key_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  delivered_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS workbench_event_delivery (
  event_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_error TEXT,
  delivered_at TEXT,
  PRIMARY KEY (event_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS workbench_plugin_run (
  id INTEGER PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_id TEXT,
  command_id TEXT,
  status TEXT NOT NULL,
  request_json TEXT,
  response_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS workbench_artifact (
  id INTEGER PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(plugin_id, event_id, kind)
);

CREATE TABLE IF NOT EXISTS workbench_qr_binding (
  token TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  view_name TEXT NOT NULL,
  key_json TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS workbench_trigger_snapshot (
  id INTEGER PRIMARY KEY,
  trigger_name TEXT NOT NULL,
  trigger_sql TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS workbench_trigger_meta (
  trigger_name TEXT PRIMARY KEY,
  description_zh TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS studio_view_meta (
  name TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  sql TEXT NOT NULL,
  edit_contract_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS schema_doc (
  kind TEXT NOT NULL CHECK (kind IN ('table', 'view')),
  name TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  description_zh TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, name)
);

CREATE TABLE IF NOT EXISTS app_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
