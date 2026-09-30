CREATE TABLE IF NOT EXISTS study_time_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 100),
  color TEXT NOT NULL DEFAULT '#4f7cac' CHECK (length(color) BETWEEN 4 AND 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_study_time_project_name
  ON study_time_project(name);

CREATE TABLE IF NOT EXISTS study_time_session (
  id TEXT PRIMARY KEY,
  timer_kind TEXT NOT NULL CHECK (timer_kind IN ('pomodoro', 'stopwatch')),
  task_text TEXT NOT NULL CHECK (length(trim(task_text)) BETWEEN 1 AND 500),
  project_id TEXT REFERENCES study_time_project(id) ON UPDATE CASCADE ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'abandoned')),
  planned_seconds INTEGER CHECK (planned_seconds IS NULL OR planned_seconds BETWEEN 60 AND 43200),
  elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  started_at TEXT NOT NULL,
  last_resumed_at TEXT,
  ended_at TEXT,
  abandoned INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_study_time_session_kind_status
  ON study_time_session(timer_kind, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_study_time_session_project
  ON study_time_session(project_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_study_time_active_kind
  ON study_time_session(timer_kind)
  WHERE status IN ('running', 'paused');
