-- Signed review disputes for false-positive L4 mitigations.

CREATE TABLE review_disputes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  agent_id TEXT NOT NULL,
  reason TEXT,
  agent_pub TEXT NOT NULL,
  sig TEXT NOT NULL,
  sig_nonce TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canon_payload TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  log_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER,
  CHECK (status IN ('open', 'resolved'))
);

CREATE UNIQUE INDEX idx_review_disputes_review_alert
  ON review_disputes(review_id, alert_id);
CREATE UNIQUE INDEX idx_review_disputes_agent_pub_sig_nonce
  ON review_disputes(agent_pub, sig_nonce);
CREATE UNIQUE INDEX idx_review_disputes_log_seq
  ON review_disputes(log_seq);
CREATE INDEX idx_review_disputes_alert_created
  ON review_disputes(alert_id, created_at DESC);
