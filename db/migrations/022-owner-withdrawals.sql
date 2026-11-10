CREATE TABLE IF NOT EXISTS wallet_withdrawals (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  requested_litoshi TEXT NOT NULL,
  send_all INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  amount_litoshi INTEGER,
  fee_litoshi INTEGER,
  txid TEXT UNIQUE,
  signed_hex TEXT,
  result TEXT,
  reason TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_utxo_reservations (
  outpoint TEXT PRIMARY KEY,
  withdrawal_id TEXT NOT NULL REFERENCES wallet_withdrawals(id)
);
