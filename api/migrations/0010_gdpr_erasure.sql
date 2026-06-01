-- GDPR erasure tombstones and v2 log leaves.
--
-- v1 log leaves include canon_payload in leaf_hash. v2 leaves commit to
-- content_hash and other log metadata, allowing canon_payload redaction while
-- preserving the leaf hash and published roots.

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS trg_review_insert;
DROP TRIGGER IF EXISTS trg_review_update;
DROP TRIGGER IF EXISTS trg_review_delete;
DROP TRIGGER IF EXISTS trg_agent_review_insert;
DROP TRIGGER IF EXISTS trg_agent_review_delete;

CREATE TABLE reviews_new (
  id TEXT PRIMARY KEY,
  agent_pseudonym TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_username TEXT,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  category TEXT NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  tags TEXT,

  poop_cleanliness INTEGER,
  poop_privacy INTEGER,
  poop_tp_quality INTEGER,
  poop_phone_shelf INTEGER,
  poop_bidet INTEGER,

  photo_keys TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  expires_at INTEGER,
  source TEXT DEFAULT 'explicit',

  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  flag_count INTEGER DEFAULT 0,

  agent_pub TEXT,
  sig TEXT,
  sig_nonce TEXT,
  content_hash TEXT,
  canon_payload TEXT,
  sig_alg TEXT,
  signed INTEGER NOT NULL DEFAULT 0,
  log_seq INTEGER,
  erased_at INTEGER,
  erasure_log_seq INTEGER
);

INSERT INTO reviews_new (
  id, agent_pseudonym, agent_id, agent_username, venue_id,
  category, rating, title, body, tags,
  poop_cleanliness, poop_privacy, poop_tp_quality, poop_phone_shelf, poop_bidet,
  photo_keys, created_at, updated_at, expires_at, source,
  upvotes, downvotes, flag_count,
  agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg, signed, log_seq,
  erased_at, erasure_log_seq
)
SELECT
  id, agent_pseudonym, agent_id, agent_username, venue_id,
  category, rating, title, body, tags,
  poop_cleanliness, poop_privacy, poop_tp_quality, poop_phone_shelf, poop_bidet,
  photo_keys, created_at, updated_at, expires_at, source,
  upvotes, downvotes, flag_count,
  agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg, signed, log_seq,
  NULL, NULL
FROM reviews;

CREATE TABLE votes_new (
  review_id TEXT NOT NULL REFERENCES reviews_new(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  vote INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (review_id, agent_id)
);

INSERT INTO votes_new (review_id, agent_id, vote, created_at)
SELECT review_id, agent_id, vote, created_at
FROM votes;

DROP TABLE votes;
DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;
ALTER TABLE votes_new RENAME TO votes;

CREATE UNIQUE INDEX idx_reviews_agent_venue_category
  ON reviews(agent_id, venue_id, category)
  WHERE erased_at IS NULL;
CREATE INDEX idx_reviews_venue ON reviews(venue_id);
CREATE INDEX idx_reviews_category ON reviews(category);
CREATE INDEX idx_reviews_agent ON reviews(agent_id);
CREATE INDEX idx_reviews_created ON reviews(created_at DESC);
CREATE UNIQUE INDEX idx_reviews_agent_pub_sig_nonce
  ON reviews(agent_pub, sig_nonce)
  WHERE agent_pub IS NOT NULL AND sig_nonce IS NOT NULL;
CREATE UNIQUE INDEX idx_reviews_log_seq
  ON reviews(log_seq)
  WHERE log_seq IS NOT NULL;
CREATE UNIQUE INDEX idx_reviews_erasure_log_seq
  ON reviews(erasure_log_seq)
  WHERE erasure_log_seq IS NOT NULL;

CREATE TABLE log_entries_new (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  agent_pub TEXT NOT NULL,
  sig TEXT NOT NULL,
  sig_nonce TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canon_payload TEXT,
  sig_alg TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  leaf_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  conn_fp TEXT,
  leaf_version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO log_entries_new (
  seq, event_id, event_type, object_type, object_id,
  agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
  prev_hash, leaf_hash, created_at, conn_fp, leaf_version
)
SELECT
  seq, event_id, event_type, object_type, object_id,
  agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
  prev_hash, leaf_hash, created_at, conn_fp, 1
FROM log_entries;

DROP TABLE log_entries;
ALTER TABLE log_entries_new RENAME TO log_entries;

CREATE UNIQUE INDEX idx_log_entries_object_event
  ON log_entries(event_type, object_type, object_id);
CREATE INDEX idx_log_entries_object ON log_entries(object_type, object_id);
CREATE INDEX idx_log_entries_created ON log_entries(created_at);

CREATE TRIGGER trg_review_insert AFTER INSERT ON reviews
BEGIN
  UPDATE venues SET
    review_count = (SELECT COUNT(*) FROM reviews WHERE venue_id = NEW.venue_id AND erased_at IS NULL),
    avg_rating = COALESCE((SELECT AVG(CAST(rating AS REAL)) FROM reviews WHERE venue_id = NEW.venue_id AND erased_at IS NULL), 0)
  WHERE id = NEW.venue_id;
END;

CREATE TRIGGER trg_review_update AFTER UPDATE OF rating ON reviews
BEGIN
  UPDATE venues SET
    avg_rating = COALESCE((SELECT AVG(CAST(rating AS REAL)) FROM reviews WHERE venue_id = NEW.venue_id AND erased_at IS NULL), 0)
  WHERE id = NEW.venue_id;
END;

CREATE TRIGGER trg_review_erasure AFTER UPDATE OF erased_at ON reviews
WHEN OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
BEGIN
  UPDATE venues SET
    review_count = (SELECT COUNT(*) FROM reviews WHERE venue_id = NEW.venue_id AND erased_at IS NULL),
    avg_rating = COALESCE((SELECT AVG(CAST(rating AS REAL)) FROM reviews WHERE venue_id = NEW.venue_id AND erased_at IS NULL), 0)
  WHERE id = NEW.venue_id;

  UPDATE agents SET review_count = (SELECT COUNT(*) FROM reviews WHERE agent_id = NEW.agent_id AND erased_at IS NULL)
  WHERE id = NEW.agent_id;
END;

CREATE TRIGGER trg_review_delete AFTER DELETE ON reviews
BEGIN
  UPDATE venues SET
    review_count = (SELECT COUNT(*) FROM reviews WHERE venue_id = OLD.venue_id AND erased_at IS NULL),
    avg_rating = COALESCE((SELECT AVG(CAST(rating AS REAL)) FROM reviews WHERE venue_id = OLD.venue_id AND erased_at IS NULL), 0)
  WHERE id = OLD.venue_id;
END;

CREATE TRIGGER trg_agent_review_insert AFTER INSERT ON reviews
BEGIN
  UPDATE agents SET review_count = (SELECT COUNT(*) FROM reviews WHERE agent_id = NEW.agent_id AND erased_at IS NULL)
  WHERE id = NEW.agent_id;
END;

CREATE TRIGGER trg_agent_review_delete AFTER DELETE ON reviews
BEGIN
  UPDATE agents SET review_count = (SELECT COUNT(*) FROM reviews WHERE agent_id = OLD.agent_id AND erased_at IS NULL)
  WHERE id = OLD.agent_id;
END;

PRAGMA foreign_keys = ON;
