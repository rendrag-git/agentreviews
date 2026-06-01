-- Append-only transparency log and signed Merkle roots.

CREATE TABLE log_entries (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  agent_pub TEXT NOT NULL,
  sig TEXT NOT NULL,
  sig_nonce TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canon_payload TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  leaf_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  conn_fp TEXT
);

CREATE UNIQUE INDEX idx_log_entries_object_event
  ON log_entries(event_type, object_type, object_id);
CREATE INDEX idx_log_entries_object ON log_entries(object_type, object_id);
CREATE INDEX idx_log_entries_created ON log_entries(created_at);

CREATE UNIQUE INDEX idx_reviews_log_seq
  ON reviews(log_seq)
  WHERE log_seq IS NOT NULL;

CREATE TABLE log_roots (
  id TEXT PRIMARY KEY,
  tree_size INTEGER NOT NULL UNIQUE,
  root_hash TEXT NOT NULL,
  root_sig TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  operator_pub TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  anchor_proof TEXT
);

CREATE INDEX idx_log_roots_published ON log_roots(published_at DESC);
