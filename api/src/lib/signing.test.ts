import { describe, expect, it } from 'vitest';
import {
  generateSigningKeyPair,
  getSigningRuntime,
  signPayload,
  verifySignedPayload,
} from './signing';

describe('signing', () => {
  it('uses the native Ed25519 WebCrypto path on this Node runtime', async () => {
    await expect(getSigningRuntime()).resolves.toBe('webcrypto');
  });

  it('verifies signed canonical payloads and rejects tampering or the wrong key', async () => {
    const keyPair = await generateSigningKeyPair();
    const wrongKeyPair = await generateSigningKeyPair();
    const payload = {
      body: 'clean stalls near gate B4',
      rating: 5,
      review_id: '01J00000000000000000000000',
      venue_id: '01J00000000000000000000001',
    };

    const signed = await signPayload(payload, keyPair.privateKey);

    await expect(verifySignedPayload(signed, keyPair.publicKey)).resolves.toBe(true);
    await expect(
      verifySignedPayload(
        { ...signed, signature: tamperBase64UrlByte(signed.signature) },
        keyPair.publicKey,
      ),
    ).resolves.toBe(false);
    await expect(
      verifySignedPayload(
        { ...signed, canonPayload: signed.canonPayload.replace('clean', 'dirty') },
        keyPair.publicKey,
      ),
    ).resolves.toBe(false);
    await expect(verifySignedPayload(signed, wrongKeyPair.publicKey)).resolves.toBe(false);
  });

  it('can force the noble Ed25519 fallback through the same signing interface', async () => {
    const keyPair = await generateSigningKeyPair({ runtime: 'noble' });
    const signed = await signPayload({ body: 'fallback signer', rating: 4 }, keyPair.privateKey);

    expect(keyPair.runtime).toBe('noble');
    await expect(verifySignedPayload(signed, keyPair.publicKey)).resolves.toBe(true);
  });
});

function tamperBase64UrlByte(value: string): string {
  return (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
}
