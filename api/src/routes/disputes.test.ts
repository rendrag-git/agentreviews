import { describe, expect, it } from 'vitest';

import { canonicalDisputePayload } from '../lib/signed-action';
import { generateSigningKeyPair, signPayload } from '../lib/signing';
import { handleDisputeReview } from './disputes';
import type { Env } from '../types';

describe('review disputes', () => {
  it('requires the review author and an active key-bound signed dispute', async () => {
    const keyPair = await generateSigningKeyPair();
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeDisputeDb({ authorPubkey: keyPair.publicKey });
    const signed = await signedDispute({
      reviewId: 'review-1',
      alertId: 'alert-1',
      reason: 'legitimate review',
      nonce: 'dispute-nonce-1',
      keyPair,
    });

    const response = await handleDisputeReview(
      new Request('https://api.test/api/v1/reviews/review-1/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      { agent_id: 'author-agent', agent_pseudonym: 'Atlas' },
      'review-1',
      1_780_000_000_000,
    );
    const body = await response.json() as { dispute_id: string; alert_id: string; status: string };

    expect(response.status).toBe(201);
    expect(body).toEqual({ dispute_id: 'dispute:review-1:alert-1', alert_id: 'alert-1', status: 'disputed' });
    expect(db.disputes).toEqual([
      expect.objectContaining({
        id: 'dispute:review-1:alert-1',
        review_id: 'review-1',
        alert_id: 'alert-1',
        agent_id: 'author-agent',
        reason: 'legitimate review',
        log_seq: 1,
      }),
    ]);
    expect(db.alerts.get('alert-1')).toEqual(expect.objectContaining({ status: 'disputed' }));
    expect(db.mitigations[0].cleared_at).toBe(1_780_000_000_000);
    expect(db.reviews.get('review-1')).toEqual({
      id: 'review-1',
      moderation_state: 'visible',
      moderation_updated_at: 1_780_000_000_000,
    });
    expect(db.logEntries).toEqual([
      expect.objectContaining({
        seq: 1,
        event_type: 'review.dispute',
        object_type: 'dispute',
        object_id: 'dispute:review-1:alert-1',
        agent_pub: keyPair.publicKey,
        sig_nonce: 'dispute-nonce-1',
      }),
      expect.objectContaining({
        seq: 2,
        event_type: 'mitigation.clear',
        object_type: 'mitigation',
        object_id: 'review-1:alert-1',
        agent_pub: operatorKey.publicKey,
        sig_nonce: 'mitigation-clear:review-1:alert-1:1780000000000',
      }),
    ]);
  });

  it('restores the review to its pre-quarantine moderation state when disputed', async () => {
    const keyPair = await generateSigningKeyPair();
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeDisputeDb({
      authorPubkey: keyPair.publicKey,
      restoreModerationState: 'soft_hidden',
    });
    const signed = await signedDispute({
      reviewId: 'review-1',
      alertId: 'alert-1',
      reason: 'legitimate but previously soft-hidden',
      nonce: 'dispute-nonce-soft-hidden',
      keyPair,
    });

    const response = await handleDisputeReview(
      new Request('https://api.test/api/v1/reviews/review-1/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      { agent_id: 'author-agent', agent_pseudonym: 'Atlas' },
      'review-1',
      1_780_000_000_000,
    );

    expect(response.status).toBe(201);
    expect(db.reviews.get('review-1')).toEqual({
      id: 'review-1',
      moderation_state: 'soft_hidden',
      moderation_updated_at: 1_780_000_000_000,
    });
  });

  it('rejects disputes from non-authors without mutating state', async () => {
    const keyPair = await generateSigningKeyPair();
    const db = new FakeDisputeDb({ authorPubkey: keyPair.publicKey });
    const signed = await signedDispute({
      reviewId: 'review-1',
      alertId: 'alert-1',
      reason: 'not mine',
      nonce: 'dispute-nonce-2',
      keyPair,
    });

    const response = await handleDisputeReview(
      new Request('https://api.test/api/v1/reviews/review-1/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      { DB: db as unknown as D1Database },
      { agent_id: 'other-agent', agent_pseudonym: 'Other' },
      'review-1',
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Only the review author can dispute this review' });
    expect(db.disputes).toHaveLength(0);
    expect(db.logEntries).toHaveLength(0);
  });

  it('rejects duplicate disputes without appending another log row', async () => {
    const keyPair = await generateSigningKeyPair();
    const db = new FakeDisputeDb({
      authorPubkey: keyPair.publicKey,
      existingDispute: true,
    });
    const signed = await signedDispute({
      reviewId: 'review-1',
      alertId: 'alert-1',
      reason: 'already filed',
      nonce: 'dispute-nonce-3',
      keyPair,
    });

    const response = await handleDisputeReview(
      new Request('https://api.test/api/v1/reviews/review-1/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      { DB: db as unknown as D1Database },
      { agent_id: 'author-agent', agent_pseudonym: 'Atlas' },
      'review-1',
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Review dispute already exists for this alert' });
    expect(db.logEntries).toHaveLength(0);
  });

  it('reports duplicate disputes even after the active mitigation has been cleared', async () => {
    const keyPair = await generateSigningKeyPair();
    const db = new FakeDisputeDb({
      authorPubkey: keyPair.publicKey,
      existingDispute: true,
      activeMitigation: false,
    });
    const signed = await signedDispute({
      reviewId: 'review-1',
      alertId: 'alert-1',
      reason: 'already filed',
      nonce: 'dispute-nonce-4',
      keyPair,
    });

    const response = await handleDisputeReview(
      new Request('https://api.test/api/v1/reviews/review-1/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      { DB: db as unknown as D1Database },
      { agent_id: 'author-agent', agent_pseudonym: 'Atlas' },
      'review-1',
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Review dispute already exists for this alert' });
    expect(db.logEntries).toHaveLength(0);
  });
});

async function signedDispute(input: {
  reviewId: string;
  alertId: string;
  reason: string;
  nonce: string;
  keyPair: { publicKey: string; privateKey: string };
}) {
  const base = {
    review_id: input.reviewId,
    alert_id: input.alertId,
    reason: input.reason,
    sig_nonce: input.nonce,
    agent_pub: input.keyPair.publicKey,
  };
  const signed = await signPayload(JSON.parse(canonicalDisputePayload(base)), input.keyPair.privateKey);
  return {
    ...base,
    sig: signed.signature,
    content_hash: signed.contentHash,
    canon_payload: signed.canonPayload,
    sig_alg: signed.sigAlg,
  };
}

class FakeDisputeDb {
  readonly alerts = new Map<string, { id: string; status: string; cleared_at: number | null }>();
  readonly mitigations: Array<{
    review_id: string;
    alert_id: string;
    cleared_at: number | null;
    restore_moderation_state: string | null;
  }>;
  readonly reviews = new Map<string, { id: string; moderation_state: string; moderation_updated_at: number | null }>();
  readonly disputes: Array<Record<string, unknown>> = [];
  readonly logEntries: Array<Record<string, unknown>> = [];
  private existingDispute: boolean;
  private activeMitigation: boolean;

  constructor(input: {
    authorPubkey: string;
    existingDispute?: boolean;
    activeMitigation?: boolean;
    restoreModerationState?: string | null;
  }) {
    this.authorPubkey = input.authorPubkey;
    this.existingDispute = Boolean(input.existingDispute);
    this.activeMitigation = input.activeMitigation ?? true;
    this.mitigations = [{
      review_id: 'review-1',
      alert_id: 'alert-1',
      cleared_at: null,
      restore_moderation_state: input.restoreModerationState ?? 'visible',
    }];
    this.reviews.set('review-1', {
      id: 'review-1',
      moderation_state: 'quarantined',
      moderation_updated_at: 100,
    });
    this.alerts.set('alert-1', { id: 'alert-1', status: 'open', cleared_at: null });
  }

  private readonly authorPubkey: string;

  prepare(sql: string) {
    return {
      first: async () => {
        if (sql.includes('SELECT seq, leaf_hash FROM log_entries')) {
          return null;
        }
        throw new Error(`Unexpected SQL without bind: ${sql}`);
      },
      bind: (...values: unknown[]) => {
        if (sql.includes('SELECT id, agent_id FROM reviews')) {
          return { first: async () => ({ id: 'review-1', agent_id: 'author-agent' }) };
        }
        if (sql.includes('SELECT pubkey, key_status FROM agents')) {
          return { first: async () => ({ pubkey: this.authorPubkey, key_status: 'active' }) };
        }
        if (sql.includes('SELECT rm.alert_id') && sql.includes('FROM review_mitigations rm')) {
          return { first: async () => (this.activeMitigation ? { alert_id: 'alert-1' } : null) };
        }
        if (sql.includes('SELECT id FROM review_disputes')) {
          return { first: async () => (this.existingDispute ? { id: 'dispute:review-1:alert-1' } : null) };
        }
        if (sql.includes('INSERT INTO review_disputes')) {
          return {
            run: async () => {
              this.existingDispute = true;
              this.disputes.push({
                id: values[0],
                review_id: values[1],
                alert_id: values[2],
                agent_id: values[3],
                reason: values[4],
                log_seq: values[11],
              });
            },
          };
        }
        if (sql.includes('INSERT INTO log_entries')) {
          return {
            run: async () => {
              this.logEntries.push({
                seq: values[0],
                event_id: values[1],
                event_type: values[2],
                object_type: values[3],
                object_id: values[4],
                agent_pub: values[5],
                sig_nonce: values[7],
                prev_hash: values[11],
              });
            },
          };
        }
        if (sql.includes('UPDATE review_mitigations')) {
          return {
            run: async () => {
              for (const row of this.mitigations) {
                if (row.review_id === values[1] && row.alert_id === values[2] && row.cleared_at === null) {
                  row.cleared_at = Number(values[0]);
                }
              }
            },
          };
        }
        if (sql.includes('UPDATE alerts SET status')) {
          return {
            run: async () => {
              const alert = this.alerts.get(String(values[2]));
              if (alert) {
                alert.status = String(values[0]);
                alert.cleared_at = Number(values[1]);
              }
            },
          };
        }
        if (sql.includes('UPDATE reviews') && sql.includes('restore_moderation_state')) {
          return {
            run: async () => {
              const alertId = String(values[0]);
              const clearedAt = Number(values[1]);
              const reviewId = String(values[3]);
              const review = this.reviews.get(reviewId);
              const mitigation = this.mitigations.find((row) => (
                row.review_id === reviewId &&
                row.alert_id === alertId &&
                row.cleared_at === clearedAt
              ));
              if (review && review.moderation_state === 'quarantined') {
                review.moderation_state = mitigation?.restore_moderation_state || 'visible';
                review.moderation_updated_at = Number(values[2]);
              }
            },
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }

  batch(statements: Array<{ run?: () => Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run?.()));
  }

  exec() {
    return Promise.resolve();
  }
}
