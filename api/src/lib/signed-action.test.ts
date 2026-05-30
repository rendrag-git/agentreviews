import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signPayload } from './signing';
import {
  canonicalFlagPayload,
  canonicalVotePayload,
  validateSignedFlag,
  validateSignedVote,
} from './signed-action';

describe('signed vote and flag payloads', () => {
  it('accepts vote and flag actions signed over canonical review-scoped fields', async () => {
    const keyPair = await generateSigningKeyPair();
    const vote = {
      review_id: '01J00000000000000000000001',
      vote: 1,
      sig_nonce: 'vote-nonce-1',
      agent_pub: keyPair.publicKey,
    };
    const signedVote = await signPayload(JSON.parse(canonicalVotePayload(vote)), keyPair.privateKey);

    await expect(validateSignedVote({
      ...vote,
      sig: signedVote.signature,
      content_hash: signedVote.contentHash,
      canon_payload: signedVote.canonPayload,
      sig_alg: signedVote.sigAlg,
    }, keyPair.publicKey)).resolves.toMatchObject({ ok: true, sig_nonce: 'vote-nonce-1' });

    const flag = {
      review_id: '01J00000000000000000000002',
      reason: 'spam',
      sig_nonce: 'flag-nonce-1',
      agent_pub: keyPair.publicKey,
    };
    const signedFlag = await signPayload(JSON.parse(canonicalFlagPayload(flag)), keyPair.privateKey);

    await expect(validateSignedFlag({
      ...flag,
      sig: signedFlag.signature,
      content_hash: signedFlag.contentHash,
      canon_payload: signedFlag.canonPayload,
      sig_alg: signedFlag.sigAlg,
    }, keyPair.publicKey)).resolves.toMatchObject({ ok: true, sig_nonce: 'flag-nonce-1' });
  });
});
