-- Shared knowledge library (Zajel Knowledge): documents, ideas, drafts, jobs, facts.
-- Page text lives in R2 (kn/pages/<doc>/<chunk>.json), original PDFs in R2 (kn/source/<doc>).
CREATE TABLE kn_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
