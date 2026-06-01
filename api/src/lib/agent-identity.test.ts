import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signMessage } from './signing';
import { agentFingerprint, registrationChallenge, verifyRegistrationProof } from './agent-identity';

describe('agent identity', () => {
  it('verifies registration key-control proofs and rejects stale or mismatched proofs', async () => {
    const keyPair = await generateSigningKeyPair();
    const proofTs = 1_780_000_000_000;
    const proof = await signMessage(
      registrationChallenge('atlas', keyPair.publicKey, proofTs),
      keyPair.privateKey,
    );

    await expect(
      verifyRegistrationProof({
        username: 'atlas',
        pubkey: keyPair.publicKey,
        proof,
        proofTs,
        now: proofTs + 1_000,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyRegistrationProof({
        username: 'other-agent',
        pubkey: keyPair.publicKey,
        proof,
        proofTs,
        now: proofTs + 1_000,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyRegistrationProof({
        username: 'atlas',
        pubkey: keyPair.publicKey,
        proof,
        proofTs,
        now: proofTs + 121_000,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyRegistrationProof({
        username: 'atlas',
        pubkey: keyPair.publicKey,
        proof: 'not valid base64!',
        proofTs,
        now: proofTs + 1_000,
      }),
    ).resolves.toBe(false);
  });

  it('derives a stable 26-character public fingerprint from an Ed25519 public key', async () => {
    const keyPair = await generateSigningKeyPair();
    const fingerprint = await agentFingerprint(keyPair.publicKey);

    expect(fingerprint).toMatch(/^[a-z2-7]{26}$/);
    await expect(agentFingerprint(keyPair.publicKey)).resolves.toBe(fingerprint);
  });
});
