import { describe, expect, it } from 'vitest';
import { publicLogEntry } from './log';

describe('public log entry serialization', () => {
  it('redacts private detector connection fingerprints', () => {
    const entry = publicLogEntry({
      seq: 1,
      event_id: 'event-1',
      event_type: 'review.create',
      object_type: 'review',
      object_id: 'review-1',
      agent_pub: 'agent-pub',
      sig: 'sig',
      sig_nonce: 'nonce',
      content_hash: 'content-hash',
      canon_payload: '{}',
      sig_alg: 'Ed25519',
      prev_hash: 'prev',
      leaf_hash: 'leaf',
      created_at: 1_780_000_000_000,
      leaf_version: 2,
      conn_fp: 'private-connection-fingerprint',
    });

    expect(entry).not.toHaveProperty('conn_fp');
    expect(JSON.stringify(entry)).not.toContain('private-connection-fingerprint');
  });
});
