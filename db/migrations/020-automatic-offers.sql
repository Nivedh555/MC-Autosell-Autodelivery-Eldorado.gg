CREATE TABLE IF NOT EXISTS automatic_offer_runs (
 id TEXT PRIMARY KEY,
 template_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 offer_id TEXT UNIQUE,
 state TEXT NOT NULL,
 request TEXT NOT NULL,
 before_ids TEXT NOT NULL,
 initial_coins TEXT NOT NULL,
 reason TEXT,
 created_ms INTEGER NOT NULL,
 updated_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS automatic_offer_open_template
 ON automatic_offer_runs(template_id) WHERE state NOT IN ('DELETED','REJECTED');
