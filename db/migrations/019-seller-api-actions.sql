CREATE TABLE IF NOT EXISTS seller_api_actions (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  reason TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
