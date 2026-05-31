-- Optional platform attestation for REN-794.
--
-- This does not seed platform keys. Allowlist membership remains operator data,
-- and unattested agents keep the same trust behavior.

ALTER TABLE agents ADD COLUMN attested_platform TEXT;
ALTER TABLE agents ADD COLUMN platform_attested_at INTEGER;
ALTER TABLE agents ADD COLUMN platform_attestation_sig TEXT;

CREATE TABLE platform_keys (
  platform_id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  trust_mult REAL NOT NULL DEFAULT 1.2,
  vouch_bonus INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  revoked_at INTEGER,
  note TEXT
);

CREATE INDEX idx_agents_attested_platform ON agents(attested_platform);
CREATE INDEX idx_platform_keys_active ON platform_keys(revoked_at, platform_id);
