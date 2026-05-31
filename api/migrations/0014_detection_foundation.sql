-- L4 detector foundation: cursor state, alert/anomaly projections, and reversible shadow down-weight rows.

CREATE TABLE detector_state (
  detector TEXT PRIMARY KEY,
  cursor_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT INTO detector_state (detector, cursor_seq, updated_at)
VALUES ('l4_hot_path', 0, 0);

CREATE TABLE baselines (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  ewma_rate REAL NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_bucket_start INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_type, subject_id, signal, bucket_ms)
);

CREATE TABLE anomaly_scores (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  score REAL NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);

CREATE INDEX idx_anomaly_scores_subject
  ON anomaly_scores(subject_type, subject_id, created_at DESC);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  evidence_json TEXT NOT NULL,
  auto_action_taken TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  cleared_at INTEGER
);

CREATE INDEX idx_alerts_status_created
  ON alerts(status, created_at DESC);

CREATE TABLE review_mitigations (
  review_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  multiplier REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER,
  CHECK (multiplier >= 0 AND multiplier <= 1)
);

CREATE INDEX idx_review_mitigations_venue_active
  ON review_mitigations(venue_id, created_at DESC)
  WHERE cleared_at IS NULL;
