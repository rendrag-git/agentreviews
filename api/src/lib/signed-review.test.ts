import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signPayload } from './signing';
import { canonicalReviewPayload, validateSignedReview } from './signed-review';

describe('signed review payloads', () => {
  it('accepts a review signed over the canonical author-controlled fields', async () => {
    const keyPair = await generateSigningKeyPair();
    const request = {
      id: '01J00000000000000000000000',
      venue_id: '01J00000000000000000000001',
      category: 'bathroom',
      rating: 5,
      title: 'Clean terminal option',
      body: 'Quiet and stocked.',
      tags: ['quiet', 'clean'],
      poop_cleanliness: 5,
      poop_privacy: 4,
      poop_tp_quality: 4,
      poop_phone_shelf: 1,
      poop_bidet: 0,
      source: 'explicit',
      sig_nonce: 'nonce-1',
      agent_pub: keyPair.publicKey,
    };
    const signed = await signPayload(JSON.parse(canonicalReviewPayload(request)), keyPair.privateKey);

    await expect(
      validateSignedReview(
        {
          ...request,
          sig: signed.signature,
          content_hash: signed.contentHash,
          canon_payload: signed.canonPayload,
          sig_alg: signed.sigAlg,
        },
        keyPair.publicKey,
      ),
    ).resolves.toMatchObject({ ok: true, sig_nonce: 'nonce-1' });
  });

  it('rejects field mismatches, bad signatures, and unbound public keys', async () => {
    const keyPair = await generateSigningKeyPair();
    const wrongKey = await generateSigningKeyPair();
    const request = {
      id: '01J00000000000000000000002',
      venue_id: '01J00000000000000000000003',
      category: 'coffee',
      rating: 4,
      body: 'Good table spacing.',
      source: 'explicit',
      sig_nonce: 'nonce-2',
      agent_pub: keyPair.publicKey,
    };
    const signed = await signPayload(JSON.parse(canonicalReviewPayload(request)), keyPair.privateKey);
    const fullRequest = {
      ...request,
      sig: signed.signature,
      content_hash: signed.contentHash,
      canon_payload: signed.canonPayload,
      sig_alg: signed.sigAlg,
    };

    await expect(validateSignedReview({ ...fullRequest, rating: 2 }, keyPair.publicKey)).resolves.toMatchObject({
      ok: false,
      error: 'Canonical payload does not match review fields',
    });
    await expect(
      validateSignedReview({ ...fullRequest, sig: 'A' + fullRequest.sig.slice(1) }, keyPair.publicKey),
    ).resolves.toMatchObject({ ok: false, error: 'Invalid review signature' });
    await expect(
      validateSignedReview({ ...fullRequest, sig: 'not valid base64!' }, keyPair.publicKey),
    ).resolves.toMatchObject({ ok: false, error: 'Invalid review signature' });
    await expect(validateSignedReview(fullRequest, wrongKey.publicKey)).resolves.toMatchObject({
      ok: false,
      error: 'Signature public key is not bound to this agent',
    });
  });
});
