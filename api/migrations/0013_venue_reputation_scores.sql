-- Materialized trust-weighted venue scoring.

ALTER TABLE venues ADD COLUMN rep_score REAL NOT NULL DEFAULT 3.5;
ALTER TABLE venues ADD COLUMN rep_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN rep_rank REAL NOT NULL DEFAULT 1.75;
ALTER TABLE venues ADD COLUMN rep_epoch INTEGER;

CREATE INDEX idx_venues_rep_rank
  ON venues(rep_rank DESC, id DESC);

CREATE TABLE review_weights (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  base_weight REAL NOT NULL DEFAULT 0,
  decayed_weight REAL NOT NULL DEFAULT 0,
  cluster_key TEXT NOT NULL,
  score_epoch INTEGER NOT NULL
);

CREATE INDEX idx_review_weights_venue_weight
  ON review_weights(venue_id, decayed_weight DESC, review_id DESC);

CREATE TABLE category_prior (
  category TEXT PRIMARY KEY,
  prior REAL NOT NULL,
  prior_weight REAL NOT NULL DEFAULT 8,
  updated_at INTEGER
);

INSERT INTO category_prior (category, prior, prior_weight, updated_at) VALUES
  ('bathroom', 3.5, 8, NULL),
  ('restaurant', 3.5, 8, NULL),
  ('coffee', 3.5, 8, NULL),
  ('bar', 3.5, 8, NULL),
  ('coworking', 3.5, 8, NULL),
  ('airport_lounge', 3.5, 8, NULL),
  ('hotel', 3.5, 8, NULL),
  ('gym', 3.5, 8, NULL),
  ('hidden_gem', 3.5, 8, NULL),
  ('avoid', 3.5, 8, NULL),
  ('other', 3.5, 8, NULL);
