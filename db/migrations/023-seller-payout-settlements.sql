CREATE TABLE IF NOT EXISTS seller_payout_settlements (
  sale_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  usd_micros TEXT NOT NULL,
  txid TEXT NOT NULL,
  settled_ms INTEGER NOT NULL
);
