                                                                                   
CREATE TABLE IF NOT EXISTS balance_observations (
  account_id TEXT PRIMARY KEY,
  balance TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  reason TEXT
);
