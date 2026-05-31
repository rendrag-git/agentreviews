import { describe, expect, it } from 'vitest';

import { generateSigningKeyPair } from '../lib/signing';
import type { DetectorMaterializationPlan } from '../lib/detector-materialization';
import { persistDetectorPlan, runMitigationRecovery } from './detection';

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

describe('mitigation recovery sweep', () => {
  it('auto-clears stale open mitigations once the decayed score falls below the clear threshold', async () => {
    const operatorKey = await generateSigningKeyPair();
    const now = 1_780_000_000_000;
    const db = new FakeRecoveryDb([
      recoveryCandidate({
        alert_id: 'alert-stale',
        review_id: 'review-stale',
        latest_score: 8,
        last_seen_at: now - 42 * 60 * 60 * 1000,
        restore_moderation_state: 'visible',
      }),
    ]);

    const result = await runMitigationRecovery(
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      now,
    );

    expect(result).toEqual({ scanned: 1, cleared: 1 });
    expect(db.mitigations[0].cleared_at).toBe(now);
    expect(db.alerts.get('alert-stale')).toEqual(expect.objectContaining({
      status: 'dismissed',
      cleared_at: now,
      pin_expires_at: now + 30 * 24 * 60 * 60 * 1000,
    }));
    expect(db.reviews.get('review-stale')).toEqual({
      id: 'review-stale',
      moderation_state: 'visible',
      moderation_updated_at: now,
    });
    expect(db.triageEvents).toEqual([
      expect.objectContaining({
        alert_id: 'alert-stale',
        action: 'auto_clear',
        reason: `auto_clear:score_below_threshold;score=1;threshold=2.5;pin_expires_at=${now + 30 * 24 * 60 * 60 * 1000}`,
        actor: 'system',
      }),
    ]);
    expect(db.logEntries).toEqual([
      expect.objectContaining({
        seq: 1,
        event_type: 'mitigation.clear',
        object_id: 'review-stale:alert-stale',
        agent_pub: operatorKey.publicKey,
      }),
    ]);
    expect(JSON.parse(String(db.logEntries[0].canon_payload))).toEqual({
      alert_id: 'alert-stale',
      event_type: 'mitigation.clear',
      reason: 'auto_clear:score_below_threshold',
      review_id: 'review-stale',
      sig_nonce: 'mitigation-clear:review-stale:alert-stale:1780000000000',
    });
  });

  it('does not clear recent alerts even when the decayed score is under threshold', async () => {
    const operatorKey = await generateSigningKeyPair();
    const now = 1_780_000_000_000;
    const db = new FakeRecoveryDb([
      recoveryCandidate({
        alert_id: 'alert-recent',
        review_id: 'review-recent',
        latest_score: 2,
        last_seen_at: now - 2 * 60 * 60 * 1000,
      }),
    ]);

    const result = await runMitigationRecovery(
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      now,
    );

    expect(result).toEqual({ scanned: 1, cleared: 0 });
    expect(db.mitigations[0].cleared_at).toBeNull();
    expect(db.alerts.get('alert-recent')?.status).toBe('open');
    expect(db.logEntries).toHaveLength(0);
    expect(db.triageEvents).toHaveLength(0);
  });

  it('leaves manual alert states untouched', async () => {
    const operatorKey = await generateSigningKeyPair();
    const now = 1_780_000_000_000;
    const db = new FakeRecoveryDb([
      recoveryCandidate({ alert_id: 'alert-confirmed', review_id: 'review-confirmed', status: 'confirmed', latest_score: 1, last_seen_at: now - 60 * 60 * 60 * 1000 }),
      recoveryCandidate({ alert_id: 'alert-dismissed', review_id: 'review-dismissed', status: 'dismissed', latest_score: 1, last_seen_at: now - 60 * 60 * 60 * 1000 }),
      recoveryCandidate({ alert_id: 'alert-disputed', review_id: 'review-disputed', status: 'disputed', latest_score: 1, last_seen_at: now - 60 * 60 * 60 * 1000 }),
    ]);

    const result = await runMitigationRecovery(
      {
        DB: db as unknown as D1Database,
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      now,
    );

    expect(result).toEqual({ scanned: 0, cleared: 0 });
    expect(db.mitigations.every((row) => row.cleared_at === null)).toBe(true);
    expect(db.logEntries).toHaveLength(0);
    expect(db.triageEvents).toHaveLength(0);
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

interface RecoveryCandidate {
  alert_id: string;
  review_id: string;
  venue_id: string;
  status: string;
  type: string;
  subject_type: string;
  subject_id: string;
  evidence_json: string;
  latest_score: number | null;
  last_seen_at: number;
  created_at: number;
  restore_moderation_state: string | null;
  cleared_at: number | null;
}

class FakeRecoveryDb {
  readonly mitigations: RecoveryCandidate[];
  readonly alerts = new Map<string, { status: string; cleared_at: number | null; pin_expires_at: number | null }>();
  readonly reviews = new Map<string, { id: string; moderation_state: string; moderation_updated_at: number | null }>();
  readonly triageEvents: Array<Record<string, unknown>> = [];
  readonly logEntries: Array<Record<string, unknown>> = [];

  constructor(candidates: RecoveryCandidate[]) {
    this.mitigations = candidates;
    for (const candidate of candidates) {
      this.alerts.set(candidate.alert_id, {
        status: candidate.status,
        cleared_at: null,
        pin_expires_at: null,
      });
      this.reviews.set(candidate.review_id, {
        id: candidate.review_id,
        moderation_state: 'quarantined',
        moderation_updated_at: 100,
      });
    }
  }

  prepare(sql: string) {
    return {
      first: async () => {
        if (sql.includes('SELECT seq, leaf_hash FROM log_entries')) {
          return null;
        }
        throw new Error(`Unexpected SQL without bind: ${sql}`);
      },
      bind: (...values: unknown[]) => {
        if (sql.includes('JOIN review_mitigations rm') && sql.includes("a.status = 'open'")) {
          return {
            all: async () => ({
              results: this.mitigations.filter((row) => row.status === 'open' && row.cleared_at === null),
            }),
          };
        }
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
        if (sql.includes('UPDATE review_mitigations')) {
          return {
            run: async () => {
              for (const row of this.mitigations) {
                if (row.alert_id === values[1] && row.cleared_at === null) {
                  row.cleared_at = Number(values[0]);
                }
              }
            },
          };
        }
        if (sql.includes('UPDATE reviews') && sql.includes('restore_moderation_state')) {
          return {
            run: async () => {
              const alertId = String(values[0]);
              const clearedAt = Number(values[1]);
              for (const row of this.mitigations.filter((item) => item.alert_id === alertId && item.cleared_at === clearedAt)) {
                const review = this.reviews.get(row.review_id);
                if (review && review.moderation_state === 'quarantined') {
                  review.moderation_state = row.restore_moderation_state || 'visible';
                  review.moderation_updated_at = Number(values[2]);
                }
              }
            },
          };
        }
        if (sql.includes('UPDATE alerts SET status =')) {
          return {
            run: async () => {
              const alert = this.alerts.get(String(values[3]));
              if (alert) {
                alert.status = String(values[0]);
                alert.cleared_at = Number(values[1]);
                alert.pin_expires_at = Number(values[2]);
              }
            },
          };
        }
        if (sql.includes('INSERT INTO alert_triage_events')) {
          return {
            run: async () => {
              this.triageEvents.push({
                id: values[0],
                alert_id: values[1],
                action: values[2],
                reason: values[3],
                actor: values[4],
                created_at: values[5],
              });
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
}

function recoveryCandidate(overrides: Partial<RecoveryCandidate>): RecoveryCandidate {
  return {
    alert_id: 'alert',
    review_id: 'review',
    venue_id: 'venue',
    status: 'open',
    type: 'venue.review_bomb',
    subject_type: 'venue',
    subject_id: 'venue',
    evidence_json: JSON.stringify({ score: 8 }),
    latest_score: 8,
    last_seen_at: 1_780_000_000_000,
    created_at: 1_780_000_000_000,
    restore_moderation_state: 'visible',
    cleared_at: null,
    ...overrides,
  };
}
