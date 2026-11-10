CREATE TABLE IF NOT EXISTS browser_actions (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, resource_id TEXT, fingerprint TEXT NOT NULL,
  state TEXT NOT NULL, request TEXT NOT NULL, result TEXT, reason TEXT,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_observations (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, data TEXT NOT NULL, created_ms INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner-requested-browser-observation'
);
