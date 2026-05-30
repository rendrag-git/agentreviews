-- Configurable trust graph foundation.
--
-- This migration intentionally does not seed trust roots. REN-784 remains the
-- human decision about which agents, if any, become active roots.

ALTER TABLE agents ADD COLUMN trust_score REAL NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN earned_trust REAL NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN vouch_trust REAL NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN trust_epoch INTEGER;

CREATE INDEX idx_agents_trust_score ON agents(trust_score DESC);
CREATE INDEX idx_agents_trust_epoch ON agents(trust_epoch);

CREATE TABLE trust_roots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  added_at INTEGER NOT NULL,
  revoked_at INTEGER,
  note TEXT
);

CREATE UNIQUE INDEX idx_trust_roots_active_agent
  ON trust_roots(agent_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_trust_roots_active
  ON trust_roots(revoked_at, agent_id);

CREATE TABLE vouches (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vouchee_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  agent_pub TEXT NOT NULL,
  sig TEXT NOT NULL,
  sig_nonce TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canon_payload TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  log_seq INTEGER
);

CREATE UNIQUE INDEX idx_vouches_active_pair
  ON vouches(voucher_id, vouchee_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_vouches_agent_pub_sig_nonce
  ON vouches(agent_pub, sig_nonce);
CREATE UNIQUE INDEX idx_vouches_log_seq
  ON vouches(log_seq)
  WHERE log_seq IS NOT NULL;
CREATE INDEX idx_vouches_voucher_active
  ON vouches(voucher_id, revoked_at);
CREATE INDEX idx_vouches_vouchee_active
  ON vouches(vouchee_id, revoked_at);
