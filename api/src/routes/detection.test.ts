import { describe, expect, it } from 'vitest';

import { generateSigningKeyPair } from '../lib/signing';
import type { DetectorMaterializationPlan } from '../lib/detector-materialization';
import { persistDetectorPlan } from './detection';

describe('detector persistence', () => {
  it('appends signed mitigation.apply entries before persisting active mitigations', async () => {
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeDetectionDb();
    const plan: DetectorMaterializationPlan = {
      detector: 'l4_hot_path',
      next_cursor_seq: 9,
      anomalyScores: [],
      alerts: [{
        id: 'alert-1',
        type: 'venue.review_bomb',
        subject_type: 'venue',
        subject_id: 'venue-1',
        severity: 'critical',
        dedup_key: 'venue.review_bomb:venue-1:82',
        status: 'open',
        evidence_json: '{}',
        auto_action_taken: 'shadow_downweight',
        created_at: 1_780_000_000_000,
        last_seen_at: 1_780_000_000_000,
      }],
      reviewMitigations: [{
        review_id: 'review-1',
        alert_id: 'alert-1',
        venue_id: 'venue-1',
        multiplier: 0.1,
        reason: 'venue.review_bomb',
        created_at: 1_780_000_000_000,
      }],
    };

    await persistDetectorPlan(
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      plan,
      1_780_000_000_000,
    );

    expect(db.logEntries).toEqual([
      expect.objectContaining({
        seq: 1,
        event_type: 'mitigation.apply',
        object_type: 'mitigation',
        object_id: 'review-1:alert-1',
        agent_pub: operatorKey.publicKey,
        sig_nonce: 'mitigation-apply:review-1:alert-1:1780000000000',
      }),
    ]);
    expect(JSON.parse(String(db.logEntries[0].canon_payload))).toEqual({
      alert_id: 'alert-1',
      event_type: 'mitigation.apply',
      multiplier: 0.1,
      reason: 'venue.review_bomb',
      review_id: 'review-1',
      sig_nonce: 'mitigation-apply:review-1:alert-1:1780000000000',
    });
    expect(db.mitigations).toEqual([
      expect.objectContaining({
        review_id: 'review-1',
        alert_id: 'alert-1',
        venue_id: 'venue-1',
        multiplier: 0.1,
        reason: 'venue.review_bomb',
      }),
    ]);
  });

  it('quarantines critical mitigated reviews while leaving lower-severity mitigations visible', async () => {
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeDetectionDb();
    const plan: DetectorMaterializationPlan = {
      detector: 'l4_hot_path',
      next_cursor_seq: 9,
      anomalyScores: [],
      alerts: [
        {
          id: 'critical-alert',
          type: 'venue.review_bomb',
          subject_type: 'venue',
          subject_id: 'venue-1',
          severity: 'critical',
          dedup_key: 'venue.review_bomb:venue-1:82',
          status: 'open',
          evidence_json: '{}',
          auto_action_taken: 'shadow_downweight',
          created_at: 1_780_000_000_000,
          last_seen_at: 1_780_000_000_000,
        },
        {
          id: 'warning-alert',
          type: 'venue.review_bomb',
          subject_type: 'venue',
          subject_id: 'venue-2',
          severity: 'warning',
          dedup_key: 'venue.review_bomb:venue-2:82',
          status: 'open',
          evidence_json: '{}',
          auto_action_taken: 'shadow_downweight',
          created_at: 1_780_000_000_000,
          last_seen_at: 1_780_000_000_000,
        },
      ],
      reviewMitigations: [
        {
          review_id: 'critical-review',
          alert_id: 'critical-alert',
          venue_id: 'venue-1',
          multiplier: 0.1,
          reason: 'venue.review_bomb',
          created_at: 1_780_000_000_000,
        },
        {
          review_id: 'warning-review',
          alert_id: 'warning-alert',
          venue_id: 'venue-2',
          multiplier: 0.5,
          reason: 'venue.review_bomb',
          created_at: 1_780_000_000_000,
        },
      ],
    };

    await persistDetectorPlan(
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      plan,
      1_780_000_000_000,
    );

    expect(db.quarantines).toEqual([
      { review_id: 'critical-review', moderation_updated_at: 1_780_000_000_000 },
    ]);
  });

  it('fails closed before mutating mitigations when operator signing is missing', async () => {
    const db = new FakeDetectionDb();
    const plan: DetectorMaterializationPlan = {
      detector: 'l4_hot_path',
      next_cursor_seq: 9,
      anomalyScores: [],
      alerts: [],
      reviewMitigations: [{
        review_id: 'review-1',
        alert_id: 'alert-1',
        venue_id: 'venue-1',
        multiplier: 0.1,
        reason: 'venue.review_bomb',
        created_at: 1_780_000_000_000,
      }],
    };

    await expect(persistDetectorPlan(
      { DB: db as unknown as D1Database },
      plan,
      1_780_000_000_000,
    )).rejects.toThrow('Operator signing key is required to append mitigation.apply');

    expect(db.logEntries).toEqual([]);
    expect(db.mitigations).toEqual([]);
  });
});

class FakeDetectionDb {
  readonly logEntries: Array<Record<string, unknown>> = [];
  readonly mitigations: Array<Record<string, unknown>> = [];
  readonly quarantines: Array<Record<string, unknown>> = [];
  readonly statements: string[] = [];

  prepare(sql: string) {
    return {
      first: async () => {
        if (sql.includes('SELECT seq, leaf_hash FROM log_entries')) {
          return null;
        }
        throw new Error(`Unexpected SQL without bind: ${sql}`);
      },
      bind: (...values: unknown[]) => {
        this.statements.push(sql);
        if (sql.includes('SELECT seq, leaf_hash FROM log_entries')) {
          return { first: async () => null };
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
                canon_payload: values[9],
              });
            },
          };
        }
        if (sql.includes('INSERT INTO review_mitigations')) {
          return {
            run: async () => {
              this.mitigations.push({
                review_id: values[0],
                alert_id: values[1],
                venue_id: values[2],
                multiplier: values[3],
                reason: values[4],
                created_at: values[5],
              });
            },
          };
        }
        if (sql.includes('UPDATE reviews') && sql.includes("moderation_state = 'quarantined'")) {
          return {
            run: async () => {
              this.quarantines.push({
                moderation_updated_at: values[0],
                review_id: values[1],
              });
            },
          };
        }
        return { run: async () => undefined };
      },
    };
  }

  batch(statements: Array<{ run?: () => Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run?.()));
  }
}
