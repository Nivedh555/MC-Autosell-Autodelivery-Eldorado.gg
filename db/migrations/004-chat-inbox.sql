CREATE TABLE IF NOT EXISTS buyer_messages (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, direction TEXT NOT NULL,
  source TEXT NOT NULL, text TEXT NOT NULL, intent TEXT, state TEXT NOT NULL,
  created_ms INTEGER NOT NULL, due_ms INTEGER NOT NULL, sent_ms INTEGER,
  UNIQUE(order_id,id)
);
CREATE INDEX IF NOT EXISTS buyer_messages_order ON buyer_messages(order_id,created_ms);
