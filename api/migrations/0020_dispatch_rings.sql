-- REN-795 bot-dispatch ring persistence.

CREATE TABLE rings (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  status TEXT NOT NULL DEFAULT 'active',
  severity TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  cleared_at INTEGER
);

CREATE INDEX idx_rings_venue_active
  ON rings(venue_id, last_seen_at DESC)
  WHERE status = 'active' AND cleared_at IS NULL;

CREATE TABLE ring_members (
  ring_id TEXT NOT NULL REFERENCES rings(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ring_id, agent_id)
);

CREATE INDEX idx_ring_members_agent
  ON ring_members(agent_id, ring_id);

CREATE TABLE co_review (
  left_agent_id TEXT NOT NULL REFERENCES agents(id),
  right_agent_id TEXT NOT NULL REFERENCES agents(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  review_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (left_agent_id, right_agent_id, venue_id)
);

CREATE INDEX idx_co_review_venue
  ON co_review(venue_id, last_seen_at DESC);

CREATE TABLE review_simhash (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  minhash_json TEXT NOT NULL,
  shingle_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
