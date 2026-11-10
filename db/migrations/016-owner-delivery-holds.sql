CREATE TABLE IF NOT EXISTS owner_delivery_holds (
  order_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  released_ms INTEGER
);
