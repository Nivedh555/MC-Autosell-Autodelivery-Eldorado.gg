CREATE TABLE IF NOT EXISTS rollout_control (
  id INTEGER PRIMARY KEY CHECK (id=1), stage TEXT NOT NULL DEFAULT 'S0',
  killed INTEGER NOT NULL DEFAULT 1, reason TEXT, updated_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO rollout_control(id,stage,killed,reason,updated_ms) VALUES(1,'S0',1,'Initial setup: live actions locked',0);
CREATE TABLE IF NOT EXISTS rollout_events (
  id INTEGER PRIMARY KEY, stage TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rollout_budget (
  order_id TEXT PRIMARY KEY, day TEXT NOT NULL, account_id TEXT NOT NULL, amount TEXT NOT NULL
);
