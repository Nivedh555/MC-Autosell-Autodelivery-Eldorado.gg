CREATE TABLE IF NOT EXISTS transfer_queue (
  sale_id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, amount TEXT NOT NULL,
  state TEXT NOT NULL, batch_id TEXT, created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_snapshots (
  account_id TEXT PRIMARY KEY, balance TEXT NOT NULL, ledger_balance TEXT NOT NULL, observed_ms INTEGER NOT NULL
);
