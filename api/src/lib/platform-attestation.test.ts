import { describe, expect, it } from 'vitest';
import { agentFingerprint } from './agent-identity';
import { verifyPlatformAttestation, platformAttestationChallenge } from './platform-attestation';
import { generateSigningKeyPair, signMessage } from './signing';

describe('platform attestation', () => {
  it('verifies allowlisted platform assertions over an agent public key and fingerprint', async () => {
    const platform = await generateSigningKeyPair();
    const agent = await generateSigningKeyPair();
    const fingerprint = await agentFingerprint(agent.publicKey);
    const issuedAt = 1_780_000_000_000;
    const sig = await signMessage(
      platformAttestationChallenge('openclaw', agent.publicKey, fingerprint, issuedAt),
      platform.privateKey,
    );

    await expect(
      verifyPlatformAttestation({
        platformPubkey: platform.publicKey,
        platformId: 'openclaw',
        agentPubkey: agent.publicKey,
        fingerprint,
        issuedAt,
        sig,
        now: issuedAt + 1_000,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyPlatformAttestation({
        platformPubkey: platform.publicKey,
        platformId: 'openclaw',
        agentPubkey: agent.publicKey,
        fingerprint: 'wrongfingerprintwrongfingerp',
        issuedAt,
        sig,
        now: issuedAt + 1_000,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyPlatformAttestation({
        platformPubkey: platform.publicKey,
        platformId: 'openclaw',
        agentPubkey: agent.publicKey,
        fingerprint,
        issuedAt,
        sig,
        now: issuedAt + 601_000,
      }),
    ).resolves.toBe(false);
  });
});
