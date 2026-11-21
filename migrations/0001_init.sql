CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'sales',
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE records (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX idx_records_seq ON records(seq);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX idx_kv_seq ON kv(seq);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta (k, v) VALUES ('seq', '0');
CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, owner TEXT, created_at TEXT NOT NULL
);
