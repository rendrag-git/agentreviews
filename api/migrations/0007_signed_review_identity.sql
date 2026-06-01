-- Agent key binding + signed review storage for phased signature rollout.

ALTER TABLE agents ADD COLUMN pubkey TEXT;
ALTER TABLE agents ADD COLUMN fingerprint TEXT;
ALTER TABLE agents ADD COLUMN key_status TEXT DEFAULT 'legacy'; -- legacy|active|superseded|revoked

CREATE UNIQUE INDEX idx_agents_pubkey ON agents(pubkey) WHERE pubkey IS NOT NULL;
CREATE UNIQUE INDEX idx_agents_fingerprint ON agents(fingerprint) WHERE fingerprint IS NOT NULL;

ALTER TABLE reviews ADD COLUMN agent_pub TEXT;
ALTER TABLE reviews ADD COLUMN sig TEXT;
ALTER TABLE reviews ADD COLUMN sig_nonce TEXT;
ALTER TABLE reviews ADD COLUMN content_hash TEXT;
ALTER TABLE reviews ADD COLUMN canon_payload TEXT;
ALTER TABLE reviews ADD COLUMN sig_alg TEXT;
ALTER TABLE reviews ADD COLUMN signed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN log_seq INTEGER;

CREATE UNIQUE INDEX idx_reviews_agent_pub_sig_nonce
  ON reviews(agent_pub, sig_nonce)
  WHERE agent_pub IS NOT NULL AND sig_nonce IS NOT NULL;
