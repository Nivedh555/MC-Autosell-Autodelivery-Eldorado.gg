-- Record the intent before a Closed offer resume can leave this process.
-- An uncertain/rejected attempt remains open until the same offer is observed
-- Active or Paused. Restarting never authorizes a second resume attempt.
CREATE TABLE offer_reopen_attempts (
 id TEXT PRIMARY KEY,
 offer_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('INTENT','CONFIRMED','REJECTED','UNKNOWN','NOT_SENT')),
 expected_offer TEXT NOT NULL,
 reason TEXT,
 http_status INTEGER,
 created_ms INTEGER NOT NULL,
 updated_ms INTEGER NOT NULL,
 resolved_ms INTEGER
);
CREATE UNIQUE INDEX offer_reopen_open_episode
 ON offer_reopen_attempts(offer_id) WHERE resolved_ms IS NULL;
