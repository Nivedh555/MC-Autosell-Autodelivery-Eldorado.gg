CREATE TABLE IF NOT EXISTS observed_order_holds (
  order_id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  resolved_ms INTEGER
);
