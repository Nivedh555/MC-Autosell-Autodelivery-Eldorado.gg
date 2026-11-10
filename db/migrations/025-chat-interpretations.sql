CREATE TABLE IF NOT EXISTS chat_interpretations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  reason TEXT,
  created_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_interpretations_order ON chat_interpretations(order_id, created_ms);
