ALTER TABLE orders ADD COLUMN details TEXT;
ALTER TABLE intake_sales ADD COLUMN context TEXT;
ALTER TABLE payout_intents ADD COLUMN signed_hex TEXT;
ALTER TABLE payout_intents ADD COLUMN txid TEXT;
ALTER TABLE payout_intents ADD COLUMN fee_litoshi INTEGER;
CREATE TABLE payout_utxo_reservations (
  outpoint TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL REFERENCES payout_intents(id)
);
CREATE INDEX payout_created ON payout_intents(created_ms);
