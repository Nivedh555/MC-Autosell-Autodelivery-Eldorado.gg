CREATE TABLE IF NOT EXISTS listing_state (
  account_id TEXT PRIMARY KEY, offer_id TEXT, state TEXT NOT NULL,
  payload TEXT, reason TEXT, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_cost_lots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, net_coins TEXT NOT NULL,
  fiat_micros TEXT NOT NULL, fee_fiat_micros TEXT NOT NULL,
  currency TEXT NOT NULL, quoted_ms INTEGER NOT NULL, source TEXT NOT NULL
);
