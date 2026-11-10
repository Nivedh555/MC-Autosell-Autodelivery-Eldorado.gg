CREATE TABLE marketplace_observations (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL,
  first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL
);
CREATE TABLE offer_turns (
  offer_id TEXT PRIMARY KEY, account_id TEXT, activated_ms INTEGER,
  reason TEXT, completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE offer_waiting (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL,
  account_id TEXT NOT NULL, balance TEXT NOT NULL, observed_ms INTEGER NOT NULL,
  UNIQUE(offer_id, account_id)
);
