-- Operator triage audit trail for L4 alert dismissal.

CREATE TABLE alert_triage_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  action TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (action IN ('dismiss'))
);

CREATE INDEX idx_alert_triage_events_alert_created
  ON alert_triage_events(alert_id, created_at DESC);
