CREATE TABLE message_outbox (
  order_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PENDING','SENDING','SENT','UNKNOWN','FAILED')),
  owner TEXT,
  submission_started INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_ms INTEGER NOT NULL,
  next_check_ms INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(order_id,logical_key)
);
CREATE UNIQUE INDEX message_outbox_one_sender ON message_outbox(order_id) WHERE state='SENDING';
