CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sellers (
  discord_id TEXT PRIMARY KEY,
  ign TEXT,
  ltc_address TEXT,
  verified_ign TEXT,
  balance_usd REAL DEFAULT 0,
  anonymous INTEGER DEFAULT 0,
  stats TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  discord_id TEXT,
  kind TEXT,
  state TEXT,
  donut_amount REAL,
  skelly_count INTEGER,
  usd_amount REAL,
  ltc_amount INTEGER,
  tx_id TEXT,
  ign TEXT,
  account_id TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  seller_discord_id TEXT,
  status TEXT,
  count INTEGER,
  payout TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE,
  entry_type TEXT,
  currency TEXT,
  amount REAL,
  reference_type TEXT,
  reference_id TEXT,
  account_id TEXT,
  metadata TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  from_account TEXT,
  to_account TEXT,
  amount REAL,
  state TEXT,
  chunks_sent INTEGER DEFAULT 0,
  chunks_total INTEGER,
  ledger_ids TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  offer_id TEXT,
  buyer_ign TEXT,
  amount REAL,
  price REAL,
  state TEXT,
  delivery_tx_ids TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  reason TEXT,
  state TEXT,
  lease_ttl_ms INTEGER,
  started_at TEXT,
  last_activity TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT,
  target TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT
);
