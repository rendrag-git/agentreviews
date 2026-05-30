-- Signed vote/flag action metadata and reversible trust-weighted moderation.

ALTER TABLE reviews ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'visible';
ALTER TABLE reviews ADD COLUMN flag_pressure REAL NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN moderation_updated_at INTEGER;

CREATE INDEX idx_reviews_moderation_state
  ON reviews(moderation_state, created_at DESC);

ALTER TABLE votes ADD COLUMN weight REAL NOT NULL DEFAULT 0;
ALTER TABLE votes ADD COLUMN agent_pub TEXT;
ALTER TABLE votes ADD COLUMN sig TEXT;
ALTER TABLE votes ADD COLUMN sig_nonce TEXT;
ALTER TABLE votes ADD COLUMN content_hash TEXT;
ALTER TABLE votes ADD COLUMN canon_payload TEXT;
ALTER TABLE votes ADD COLUMN sig_alg TEXT;
ALTER TABLE votes ADD COLUMN signed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE votes ADD COLUMN log_seq INTEGER;
ALTER TABLE votes ADD COLUMN action_id TEXT;

CREATE UNIQUE INDEX idx_votes_agent_pub_sig_nonce
  ON votes(agent_pub, sig_nonce)
  WHERE agent_pub IS NOT NULL AND sig_nonce IS NOT NULL;
CREATE UNIQUE INDEX idx_votes_log_seq
  ON votes(log_seq)
  WHERE log_seq IS NOT NULL;
CREATE UNIQUE INDEX idx_votes_action_id
  ON votes(action_id)
  WHERE action_id IS NOT NULL;

ALTER TABLE flags ADD COLUMN weight REAL NOT NULL DEFAULT 0;
ALTER TABLE flags ADD COLUMN agent_pub TEXT;
ALTER TABLE flags ADD COLUMN sig TEXT;
ALTER TABLE flags ADD COLUMN sig_nonce TEXT;
ALTER TABLE flags ADD COLUMN content_hash TEXT;
ALTER TABLE flags ADD COLUMN canon_payload TEXT;
ALTER TABLE flags ADD COLUMN sig_alg TEXT;
ALTER TABLE flags ADD COLUMN signed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flags ADD COLUMN log_seq INTEGER;
ALTER TABLE flags ADD COLUMN action_id TEXT;

CREATE UNIQUE INDEX idx_flags_agent_pub_sig_nonce
  ON flags(agent_pub, sig_nonce)
  WHERE agent_pub IS NOT NULL AND sig_nonce IS NOT NULL;
CREATE UNIQUE INDEX idx_flags_log_seq
  ON flags(log_seq)
  WHERE log_seq IS NOT NULL;
CREATE UNIQUE INDEX idx_flags_action_id
  ON flags(action_id)
  WHERE action_id IS NOT NULL;
