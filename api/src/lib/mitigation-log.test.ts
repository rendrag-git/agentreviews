import { describe, expect, it } from 'vitest';

import { generateSigningKeyPair, verifySignedPayload } from './signing';
import { buildMitigationApplyLogEntries, buildMitigationClearLogEntries } from './mitigation-log';
import { GENESIS_PREV_HASH, verifyLogEntryHash } from './transparency-log';

describe('signed mitigation log entries', () => {
  it('builds operator-signed apply and clear entries without detector evidence', async () => {
    const operatorKey = await generateSigningKeyPair();
    const env = {
      OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
      OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
    };

    const [apply] = await buildMitigationApplyLogEntries({
      env,
      mitigations: [{
        review_id: 'review-1',
        alert_id: 'alert-1',
        reason: 'venue.review_bomb',
        multiplier: 0.1,
      }],
      now: 1_780_000_000_000,
      startSeq: 1,
      prevHash: GENESIS_PREV_HASH,
    });
    const [clear] = await buildMitigationClearLogEntries({
      env,
      mitigations: [{ review_id: 'review-1', alert_id: 'alert-1' }],
      reason: 'false positive',
      now: 1_780_000_001_000,
      startSeq: 2,
      prevHash: apply.leaf_hash,
    });

    expect(apply).toMatchObject({
      seq: 1,
      event_type: 'mitigation.apply',
      object_type: 'mitigation',
      object_id: 'review-1:alert-1',
      agent_pub: operatorKey.publicKey,
      sig_nonce: 'mitigation-apply:review-1:alert-1:1780000000000',
    });
    expect(JSON.parse(apply.canon_payload || '{}')).toEqual({
      alert_id: 'alert-1',
      event_type: 'mitigation.apply',
      multiplier: 0.1,
      reason: 'venue.review_bomb',
      review_id: 'review-1',
      sig_nonce: 'mitigation-apply:review-1:alert-1:1780000000000',
    });
    expect(apply.canon_payload).not.toContain('conn_fp');
    expect(await verifySignedPayload({
      sigAlg: 'Ed25519',
      signature: apply.sig,
      contentHash: apply.content_hash,
      canonPayload: apply.canon_payload || '',
    }, operatorKey.publicKey)).toBe(true);
    expect(await verifyLogEntryHash(apply)).toBe(true);

    expect(clear).toMatchObject({
      seq: 2,
      event_type: 'mitigation.clear',
      object_type: 'mitigation',
      object_id: 'review-1:alert-1',
      prev_hash: apply.leaf_hash,
      sig_nonce: 'mitigation-clear:review-1:alert-1:1780000001000',
    });
    expect(await verifySignedPayload({
      sigAlg: 'Ed25519',
      signature: clear.sig,
      contentHash: clear.content_hash,
      canonPayload: clear.canon_payload || '',
    }, operatorKey.publicKey)).toBe(true);
    expect(await verifyLogEntryHash(clear)).toBe(true);
  });
});
