CREATE TABLE IF NOT EXISTS intake_sales (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sender TEXT NOT NULL, amount TEXT NOT NULL,
  before_balance TEXT NOT NULL, after_balance TEXT, state TEXT NOT NULL, reason TEXT, capture TEXT,
  created_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS intake_one_pending ON intake_sales(account_id) WHERE state IN ('ARMED','CHECKING','NEEDS_OPERATOR');
CREATE TABLE IF NOT EXISTS payout_intents (
  id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, address TEXT NOT NULL, fiat_micros TEXT NOT NULL,
  litoshi TEXT NOT NULL, state TEXT NOT NULL, result TEXT, reason TEXT, created_ms INTEGER NOT NULL
);
