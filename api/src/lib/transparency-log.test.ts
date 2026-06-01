import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './signing';
import {
  buildReviewCreateLogEntry,
  buildReviewEraseLogEntry,
  GENESIS_PREV_HASH,
  signTreeHead,
  verifyTreeHeadSignature,
  verifyLogEntryHash,
} from './transparency-log';

describe('transparency log entries', () => {
  it('builds a tamper-evident review.create leaf from signed review metadata', async () => {
    const entry = await buildReviewCreateLogEntry({
      seq: 1,
      eventId: '01J00000000000000000000010',
      reviewId: '01J00000000000000000000000',
      agentPub: 'agent-pub',
      sig: 'sig',
      sigNonce: 'nonce-1',
      contentHash: 'content-hash',
      canonPayload: '{"body":"Quiet and stocked."}',
      sigAlg: 'Ed25519',
      prevHash: GENESIS_PREV_HASH,
      createdAt: 1_780_000_000_000,
    });

    expect(entry).toMatchObject({
      seq: 1,
      event_id: '01J00000000000000000000010',
      event_type: 'review.create',
      object_type: 'review',
      object_id: '01J00000000000000000000000',
      prev_hash: GENESIS_PREV_HASH,
    });
    await expect(verifyLogEntryHash(entry)).resolves.toBe(true);
    await expect(verifyLogEntryHash({ ...entry, content_hash: 'different' })).resolves.toBe(false);
    await expect(
      buildReviewCreateLogEntry({
        seq: 1,
        eventId: '01J00000000000000000000010',
        reviewId: '01J00000000000000000000000',
        agentPub: 'agent-pub',
        sig: 'sig',
        sigNonce: 'nonce-1',
        contentHash: 'content-hash',
        canonPayload: '{"body":"Quiet and stocked."}',
        sigAlg: 'Ed25519',
        prevHash: 'previous-entry',
        createdAt: 1_780_000_000_000,
      }),
    ).resolves.not.toMatchObject({ leaf_hash: entry.leaf_hash });
  });

  it('keeps v2 review.create leaves verifiable after signed payload redaction', async () => {
    const entry = await buildReviewCreateLogEntry({
      seq: 1,
      eventId: '01J00000000000000000000011',
      reviewId: '01J00000000000000000000000',
      agentPub: 'agent-pub',
      sig: 'sig',
      sigNonce: 'nonce-1',
      contentHash: 'content-hash',
      canonPayload: '{"body":"Quiet and stocked."}',
      sigAlg: 'Ed25519',
      prevHash: GENESIS_PREV_HASH,
      createdAt: 1_780_000_000_000,
    });

    expect(entry.leaf_version).toBe(2);
    await expect(verifyLogEntryHash({ ...entry, canon_payload: null })).resolves.toBe(true);
  });

  it('builds a signed review.erase leaf for a tombstoned review slot', async () => {
    const entry = await buildReviewEraseLogEntry({
      seq: 2,
      eventId: '01J00000000000000000000012',
      reviewId: '01J00000000000000000000000',
      agentPub: 'agent-pub',
      sig: 'erase-sig',
      sigNonce: 'erase-nonce-1',
      contentHash: 'erase-payload-hash',
      canonPayload: '{"erased_content_hash":"content-hash","event_type":"review.erase","review_id":"01J00000000000000000000000","sig_nonce":"erase-nonce-1"}',
      sigAlg: 'Ed25519',
      prevHash: 'previous-entry',
      createdAt: 1_780_000_000_100,
    });

    expect(entry).toMatchObject({
      seq: 2,
      event_type: 'review.erase',
      object_type: 'review',
      object_id: '01J00000000000000000000000',
      leaf_version: 2,
    });
    await expect(verifyLogEntryHash(entry)).resolves.toBe(true);
    await expect(verifyLogEntryHash({ ...entry, event_type: 'review.create' })).resolves.toBe(false);
  });

  it('signs and verifies operator Merkle tree heads', async () => {
    const keyPair = await generateSigningKeyPair();
    const treeHead = {
      tree_size: 3,
      root_hash: 'root-hash',
      published_at: 1_780_000_000_000,
    };
    const rootSig = await signTreeHead(treeHead, keyPair.privateKey);

    await expect(verifyTreeHeadSignature({ ...treeHead, root_sig: rootSig }, keyPair.publicKey)).resolves.toBe(true);
    await expect(
      verifyTreeHeadSignature({ ...treeHead, tree_size: 2, root_sig: rootSig }, keyPair.publicKey),
    ).resolves.toBe(false);
  });
});
