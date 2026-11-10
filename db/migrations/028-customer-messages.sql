CREATE TABLE customer_message_templates (
  event TEXT PRIMARY KEY, text TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>0), updated_ms INTEGER NOT NULL
);
CREATE TABLE customer_message_snapshots (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, event TEXT NOT NULL, revision INTEGER NOT NULL,
  text TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), binding TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING', created_ms INTEGER NOT NULL
);
CREATE INDEX customer_message_order ON customer_message_snapshots(order_id,event);
CREATE TABLE customer_message_options (
  id INTEGER PRIMARY KEY CHECK(id=1), guides_enabled INTEGER NOT NULL DEFAULT 0 CHECK(guides_enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1, initialized_ms INTEGER NOT NULL
);
INSERT INTO customer_message_options VALUES(1,0,1,CAST(strftime('%s','now') AS INTEGER)*1000);
-- The first run must not schedule a newly enabled template for an old delivered
-- order. A physical legacy send, if one exists, is reconciled by its old id.
INSERT INTO customer_message_snapshots
SELECT prefix||d.id,d.id,event,1,'',0,NULL,'SKIPPED',d.updated_ms FROM delivery_orders d
JOIN (SELECT 'v3-completion:' prefix,'order_delivered' event UNION ALL SELECT 'customer-review:','review_request' UNION ALL SELECT 'customer-guides:','confirmation_guides')
WHERE d.state='DELIVERED';
CREATE TABLE customer_message_attempts (
  message_id TEXT PRIMARY KEY REFERENCES customer_message_snapshots(id), attempts INTEGER NOT NULL,
  next_attempt_ms INTEGER NOT NULL, reason TEXT
);
