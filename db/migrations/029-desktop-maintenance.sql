CREATE TABLE desktop_maintenance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  target_version TEXT,
  reason TEXT,
  updated_ms INTEGER NOT NULL
);
INSERT INTO desktop_maintenance(id,active,updated_ms) VALUES(1,0,0);
