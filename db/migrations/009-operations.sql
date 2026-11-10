CREATE TABLE IF NOT EXISTS operator_alerts (
  id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, component TEXT NOT NULL,
  order_id TEXT, reason TEXT NOT NULL, created_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1, notification_state TEXT NOT NULL DEFAULT 'pending',
  acknowledged_ms INTEGER
);
CREATE TABLE IF NOT EXISTS runtime_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, step TEXT NOT NULL,
  elapsed_ms REAL NOT NULL, outcome TEXT NOT NULL, created_ms INTEGER NOT NULL
);
