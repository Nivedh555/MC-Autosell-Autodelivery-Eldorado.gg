CREATE TABLE IF NOT EXISTS marketplace_monitoring (
  scope TEXT PRIMARY KEY,
  seller_href TEXT NOT NULL,
  since_ms INTEGER NOT NULL,
  scan_state TEXT NOT NULL DEFAULT '{}'
);
