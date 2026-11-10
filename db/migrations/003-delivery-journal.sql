CREATE TABLE IF NOT EXISTS delivery_orders (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL, reason TEXT, mode TEXT NOT NULL,
  account_id TEXT, evidence TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0, mark_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS delivery_chunks (
  order_id TEXT NOT NULL REFERENCES delivery_orders(id), chunk_index INTEGER NOT NULL,
  amount TEXT NOT NULL, command_amount TEXT NOT NULL, debit TEXT NOT NULL,
  state TEXT NOT NULL, before_balance TEXT, after_balance TEXT, result TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  PRIMARY KEY(order_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS delivery_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES delivery_orders(id),
  kind TEXT NOT NULL, data TEXT NOT NULL, wall_ms INTEGER NOT NULL, monotonic_ns TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_account_locks (
  account_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES delivery_orders(id),
  owner TEXT NOT NULL, reserved_amount TEXT NOT NULL, balance TEXT NOT NULL, acquired_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery_orders(state,next_attempt_ms);
CREATE TABLE IF NOT EXISTS delivery_order_claims (
  order_id TEXT PRIMARY KEY REFERENCES delivery_orders(id), owner TEXT NOT NULL
);
