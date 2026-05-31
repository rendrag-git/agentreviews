-- Keep venue raw aggregates aligned with public-visible reviews only.

ALTER TABLE review_mitigations ADD COLUMN restore_moderation_state TEXT;

CREATE TABLE alert_triage_events_new (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  action TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (action IN ('dismiss', 'confirm'))
);

INSERT INTO alert_triage_events_new (id, alert_id, action, reason, actor, created_at)
SELECT id, alert_id, action, reason, actor, created_at
FROM alert_triage_events;

DROP TABLE alert_triage_events;
ALTER TABLE alert_triage_events_new RENAME TO alert_triage_events;

CREATE INDEX idx_alert_triage_events_alert_created
  ON alert_triage_events(alert_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_review_insert;
DROP TRIGGER IF EXISTS trg_review_update;
DROP TRIGGER IF EXISTS trg_review_erasure;
DROP TRIGGER IF EXISTS trg_review_delete;
DROP TRIGGER IF EXISTS trg_review_moderation_state;

CREATE TRIGGER trg_review_insert AFTER INSERT ON reviews
BEGIN
  UPDATE venues SET
    review_count = (
      SELECT COUNT(*) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ),
    avg_rating = COALESCE((
      SELECT AVG(CAST(rating AS REAL)) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ), 0)
  WHERE id = NEW.venue_id;
END;

CREATE TRIGGER trg_review_update AFTER UPDATE OF rating ON reviews
BEGIN
  UPDATE venues SET
    avg_rating = COALESCE((
      SELECT AVG(CAST(rating AS REAL)) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ), 0)
  WHERE id = NEW.venue_id;
END;

CREATE TRIGGER trg_review_erasure AFTER UPDATE OF erased_at ON reviews
WHEN OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
BEGIN
  UPDATE venues SET
    review_count = (
      SELECT COUNT(*) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ),
    avg_rating = COALESCE((
      SELECT AVG(CAST(rating AS REAL)) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ), 0)
  WHERE id = NEW.venue_id;

  UPDATE agents SET review_count = (SELECT COUNT(*) FROM reviews WHERE agent_id = NEW.agent_id AND erased_at IS NULL)
  WHERE id = NEW.agent_id;
END;

CREATE TRIGGER trg_review_delete AFTER DELETE ON reviews
BEGIN
  UPDATE venues SET
    review_count = (
      SELECT COUNT(*) FROM reviews
      WHERE venue_id = OLD.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ),
    avg_rating = COALESCE((
      SELECT AVG(CAST(rating AS REAL)) FROM reviews
      WHERE venue_id = OLD.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ), 0)
  WHERE id = OLD.venue_id;
END;

CREATE TRIGGER trg_review_moderation_state AFTER UPDATE OF moderation_state ON reviews
WHEN OLD.moderation_state != NEW.moderation_state
BEGIN
  UPDATE venues SET
    review_count = (
      SELECT COUNT(*) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ),
    avg_rating = COALESCE((
      SELECT AVG(CAST(rating AS REAL)) FROM reviews
      WHERE venue_id = NEW.venue_id
        AND erased_at IS NULL
        AND moderation_state = 'visible'
    ), 0)
  WHERE id = NEW.venue_id;
END;

UPDATE venues SET
  review_count = (
    SELECT COUNT(*) FROM reviews
    WHERE venue_id = venues.id
      AND erased_at IS NULL
      AND moderation_state = 'visible'
  ),
  avg_rating = COALESCE((
    SELECT AVG(CAST(rating AS REAL)) FROM reviews
    WHERE venue_id = venues.id
      AND erased_at IS NULL
      AND moderation_state = 'visible'
  ), 0);
