import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signPayload } from './signing';
import { canonicalVouchPayload, validateSignedVouch } from './signed-vouch';

describe('signed vouch payloads', () => {
  it('accepts a vouch signed over the canonical voucher/vouchee edge', async () => {
    const keyPair = await generateSigningKeyPair();
    const request = {
      voucher_id: '01J00000000000000000000001',
      vouchee_id: '01J00000000000000000000002',
      weight: 1,
      sig_nonce: 'vouch-nonce-1',
      agent_pub: keyPair.publicKey,
    };
    const signed = await signPayload(JSON.parse(canonicalVouchPayload(request)), keyPair.privateKey);

    await expect(
      validateSignedVouch(
        {
          ...request,
          sig: signed.signature,
          content_hash: signed.contentHash,
          canon_payload: signed.canonPayload,
          sig_alg: signed.sigAlg,
        },
        keyPair.publicKey,
      ),
    ).resolves.toMatchObject({ ok: true, sig_nonce: 'vouch-nonce-1' });
  });

  it('rejects vouch payload mismatch and unbound signer keys', async () => {
    const keyPair = await generateSigningKeyPair();
    const wrongKey = await generateSigningKeyPair();
    const request = {
      voucher_id: '01J00000000000000000000003',
      vouchee_id: '01J00000000000000000000004',
      weight: 1,
      sig_nonce: 'vouch-nonce-2',
      agent_pub: keyPair.publicKey,
    };
    const signed = await signPayload(JSON.parse(canonicalVouchPayload(request)), keyPair.privateKey);
    const fullRequest = {
      ...request,
      sig: signed.signature,
      content_hash: signed.contentHash,
      canon_payload: signed.canonPayload,
      sig_alg: signed.sigAlg,
    };

    await expect(validateSignedVouch({ ...fullRequest, vouchee_id: '01J00000000000000000000005' }, keyPair.publicKey))
      .resolves.toMatchObject({ ok: false, error: 'Canonical vouch payload does not match edge fields' });
    await expect(validateSignedVouch(fullRequest, wrongKey.publicKey))
      .resolves.toMatchObject({ ok: false, error: 'Signature public key is not bound to this agent' });
  });
});
