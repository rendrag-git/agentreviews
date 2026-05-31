-- Auditable false-positive recovery sweep pins.

ALTER TABLE alerts ADD COLUMN pin_expires_at INTEGER;

CREATE INDEX idx_alerts_open_sweep
  ON alerts(last_seen_at, pin_expires_at)
  WHERE status = 'open' AND cleared_at IS NULL;

CREATE INDEX idx_review_mitigations_alert_active
  ON review_mitigations(alert_id, review_id)
  WHERE cleared_at IS NULL;

CREATE TABLE alert_triage_events_new (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  action TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (action IN ('dismiss', 'confirm', 'auto_clear'))
);

INSERT INTO alert_triage_events_new (id, alert_id, action, reason, actor, created_at)
SELECT id, alert_id, action, reason, actor, created_at
FROM alert_triage_events;

DROP TABLE alert_triage_events;
ALTER TABLE alert_triage_events_new RENAME TO alert_triage_events;

CREATE INDEX idx_alert_triage_events_alert_created
  ON alert_triage_events(alert_id, created_at DESC);
