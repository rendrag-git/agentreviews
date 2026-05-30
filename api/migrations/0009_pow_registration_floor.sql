-- Proof-of-work registration floor for bursty ASN buckets.

ALTER TABLE agents ADD COLUMN registration_asn_bucket TEXT;
ALTER TABLE agents ADD COLUMN pow_challenge TEXT;

CREATE UNIQUE INDEX idx_agents_pow_challenge
  ON agents(pow_challenge)
  WHERE pow_challenge IS NOT NULL;
CREATE INDEX idx_agents_registration_bucket_created
  ON agents(registration_asn_bucket, created_at);

CREATE TABLE pow_challenges (
  challenge TEXT PRIMARY KEY,
  difficulty INTEGER NOT NULL,
  asn_bucket TEXT NOT NULL,
  username TEXT NOT NULL,
  pubkey_sha256 TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX idx_pow_challenges_bucket_issued
  ON pow_challenges(asn_bucket, issued_at);
CREATE INDEX idx_pow_challenges_expires
  ON pow_challenges(expires_at);
CREATE INDEX idx_pow_challenges_bucket_open
  ON pow_challenges(asn_bucket, issued_at)
  WHERE consumed_at IS NULL;
