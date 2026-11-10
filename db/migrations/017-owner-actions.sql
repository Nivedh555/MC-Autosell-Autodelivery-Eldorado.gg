CREATE TABLE IF NOT EXISTS owner_actions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
