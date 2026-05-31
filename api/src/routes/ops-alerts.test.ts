import { describe, expect, it } from 'vitest';

import { generateSigningKeyPair } from '../lib/signing';
import { handleConfirmOpsAlert, handleDismissOpsAlert, handleListOpsAlerts } from './ops-alerts';
import type { Env } from '../types';

interface AlertRow {
  id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  severity: string;
  dedup_key: string;
  status: string;
  evidence_json: string;
  auto_action_taken: string | null;
  delivered_at: number | null;
  created_at: number;
  last_seen_at: number;
  cleared_at: number | null;
  mitigation_count?: number;
}

interface TriageRow {
  id: string;
  alert_id: string;
  action: string;
  reason: string | null;
  actor: string;
  created_at: number;
}

interface MitigationRow {
  review_id: string;
  alert_id: string;
  cleared_at: number | null;
  restore_moderation_state?: string | null;
}

describe('ops alert triage', () => {
  it('rejects list requests without the ops token', async () => {
    const db = new FakeOpsAlertDb();

    const response = await handleListOpsAlerts(
      new Request('https://api.test/api/v1/ops/alerts'),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Ops authentication required' });
    expect(db.queries).toHaveLength(0);
  });

  it('fails closed without a configured ops token', async () => {
    const db = new FakeOpsAlertDb();

    const response = await handleListOpsAlerts(
      new Request('https://api.test/api/v1/ops/alerts', {
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      { DB: db as unknown as D1Database },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Ops authentication is not configured' });
    expect(db.queries).toHaveLength(0);
  });

  it('lists open alerts newest-first with redacted evidence and active mitigation counts', async () => {
    const db = new FakeOpsAlertDb([
      alert({
        id: 'older',
        created_at: 100,
        evidence_json: JSON.stringify({ review_count: 7 }),
        mitigation_count: 0,
      }),
      alert({
        id: 'newer',
        type: 'agent.targeted',
        subject_type: 'agent',
        subject_id: 'agent-under-attack',
        created_at: 200,
        evidence_json: JSON.stringify({
          score: 8.5,
          conn_fp: 'private-fingerprint',
          suspect_review_ids: ['review-a'],
          suspect_action_ids: ['vote-a'],
          target_agent_id: 'agent-under-attack',
          venue_ids: ['venue-a'],
        }),
        mitigation_count: 3,
      }),
      alert({ id: 'dismissed', status: 'dismissed', created_at: 300, mitigation_count: 10 }),
      alert({ id: 'disputed', status: 'disputed', created_at: 400, mitigation_count: 0 }),
    ]);

    const response = await handleListOpsAlerts(
      new Request('https://api.test/api/v1/ops/alerts?status=open', {
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
    );
    const body = await response.json() as {
      alerts: Array<{ id: string; evidence: Record<string, unknown>; active_mitigation_count: number }>;
      count: number;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.count).toBe(2);
    expect(body.alerts.map((row) => row.id)).toEqual(['newer', 'older']);
    expect(body.alerts[0].active_mitigation_count).toBe(3);
    expect(body.alerts[0].evidence).toEqual({ score: 8.5 });
    expect(JSON.stringify(body)).not.toContain('private-fingerprint');
    expect(JSON.stringify(body)).not.toContain('suspect_review_ids');
    expect(JSON.stringify(body)).not.toContain('agent-under-attack');
    expect(JSON.stringify(body)).not.toContain('venue-a');
  });

  it('can list disputed alerts for ops follow-up', async () => {
    const db = new FakeOpsAlertDb([
      alert({ id: 'disputed', status: 'disputed', created_at: 400, mitigation_count: 0 }),
    ]);

    const response = await handleListOpsAlerts(
      new Request('https://api.test/api/v1/ops/alerts?status=disputed', {
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
    );
    const body = await response.json() as { alerts: Array<{ id: string; status: string }>; count: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      count: 1,
      alerts: [{ id: 'disputed', status: 'disputed' }],
    });
  });

  it('can list confirmed alerts for ops follow-up', async () => {
    const db = new FakeOpsAlertDb([
      alert({ id: 'confirmed', status: 'confirmed', created_at: 400, mitigation_count: 1 }),
    ], [
      { review_id: 'review-active', alert_id: 'confirmed', cleared_at: null },
    ]);

    const response = await handleListOpsAlerts(
      new Request('https://api.test/api/v1/ops/alerts?status=confirmed', {
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
    );
    const body = await response.json() as { alerts: Array<{ id: string; status: string; active_mitigation_count: number }>; count: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      count: 1,
      alerts: [{ id: 'confirmed', status: 'confirmed', active_mitigation_count: 1 }],
    });
  });

  it('dismisses an alert, clears active mitigations, and records signed clear events', async () => {
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeOpsAlertDb([
      alert({ id: 'alert-1', status: 'open', cleared_at: null }),
    ], [
      { review_id: 'review-active', alert_id: 'alert-1', cleared_at: null },
      { review_id: 'review-already-cleared', alert_id: 'alert-1', cleared_at: 50 },
    ]);

    const response = await handleDismissOpsAlert(
      new Request('https://api.test/api/v1/ops/alerts/alert-1/dismiss', {
        method: 'POST',
        headers: { Authorization: 'Bearer ops-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'false positive' }),
      }),
      {
        DB: db as unknown as D1Database,
        OPS_ALERTS_TOKEN: 'ops-secret',
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      'alert-1',
      1_780_000_000_000,
    );
    const body = await response.json() as { alert_id: string; status: string; cleared_mitigations: number };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({ alert_id: 'alert-1', status: 'dismissed', cleared_mitigations: 1 });
    expect(db.alerts.get('alert-1')).toEqual(expect.objectContaining({
      status: 'dismissed',
      cleared_at: 1_780_000_000_000,
    }));
    expect(db.mitigations.find((row) => row.review_id === 'review-active')?.cleared_at).toBe(1_780_000_000_000);
    expect(db.mitigations.find((row) => row.review_id === 'review-already-cleared')?.cleared_at).toBe(50);
    expect(db.triageEvents).toEqual([
      expect.objectContaining({
        alert_id: 'alert-1',
        action: 'dismiss',
        reason: 'false positive',
        actor: 'ops-token',
        created_at: 1_780_000_000_000,
      }),
    ]);
    expect(db.logEntries).toEqual([
      expect.objectContaining({
        seq: 1,
        event_type: 'mitigation.clear',
        object_type: 'mitigation',
        object_id: 'review-active:alert-1',
        agent_pub: operatorKey.publicKey,
      }),
    ]);
    expect(JSON.parse(String(db.logEntries[0].canon_payload))).toEqual({
      alert_id: 'alert-1',
      event_type: 'mitigation.clear',
      reason: 'false positive',
      review_id: 'review-active',
      sig_nonce: 'mitigation-clear:review-active:alert-1:1780000000000',
    });
  });

  it('dismisses an alert and restores its quarantined reviews to their previous moderation state', async () => {
    const operatorKey = await generateSigningKeyPair();
    const db = new FakeOpsAlertDb([
      alert({ id: 'alert-1', status: 'open', cleared_at: null }),
    ], [
      { review_id: 'review-active', alert_id: 'alert-1', cleared_at: null, restore_moderation_state: 'visible' },
      { review_id: 'review-soft-hidden', alert_id: 'alert-1', cleared_at: null, restore_moderation_state: 'soft_hidden' },
    ], [
      { id: 'review-active', moderation_state: 'quarantined', moderation_updated_at: 100 },
      { id: 'review-soft-hidden', moderation_state: 'quarantined', moderation_updated_at: 100 },
      { id: 'review-other', moderation_state: 'quarantined', moderation_updated_at: 100 },
    ]);

    const response = await handleDismissOpsAlert(
      new Request('https://api.test/api/v1/ops/alerts/alert-1/dismiss', {
        method: 'POST',
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      {
        DB: db as unknown as D1Database,
        OPS_ALERTS_TOKEN: 'ops-secret',
        OPERATOR_PRIVATE_KEY: operatorKey.privateKey,
        OPERATOR_PUBLIC_KEY: operatorKey.publicKey,
      },
      'alert-1',
      1_780_000_000_000,
    );

    expect(response.status).toBe(200);
    expect(db.reviews.get('review-active')).toEqual({
      id: 'review-active',
      moderation_state: 'visible',
      moderation_updated_at: 1_780_000_000_000,
    });
    expect(db.reviews.get('review-soft-hidden')).toEqual({
      id: 'review-soft-hidden',
      moderation_state: 'soft_hidden',
      moderation_updated_at: 1_780_000_000_000,
    });
    expect(db.reviews.get('review-other')).toEqual({
      id: 'review-other',
      moderation_state: 'quarantined',
      moderation_updated_at: 100,
    });
  });

  it('keeps already-dismissed alerts idempotent without rewriting audit state', async () => {
    const db = new FakeOpsAlertDb([
      alert({ id: 'alert-1', status: 'dismissed', cleared_at: 50 }),
    ]);

    const response = await handleDismissOpsAlert(
      new Request('https://api.test/api/v1/ops/alerts/alert-1/dismiss', {
        method: 'POST',
        headers: { Authorization: 'Bearer ops-secret' },
      }),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
      'alert-1',
      1_780_000_000_000,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      alert_id: 'alert-1',
      status: 'dismissed',
      cleared_mitigations: 0,
    });
    expect(db.alerts.get('alert-1')?.cleared_at).toBe(50);
    expect(db.triageEvents).toHaveLength(0);
  });

  it('confirms an alert without clearing mitigations or restoring quarantined reviews', async () => {
    const db = new FakeOpsAlertDb([
      alert({ id: 'alert-1', status: 'open', cleared_at: null }),
    ], [
      { review_id: 'review-active', alert_id: 'alert-1', cleared_at: null, restore_moderation_state: 'visible' },
    ], [
      { id: 'review-active', moderation_state: 'quarantined', moderation_updated_at: 100 },
    ]);

    const response = await handleConfirmOpsAlert(
      new Request('https://api.test/api/v1/ops/alerts/alert-1/confirm', {
        method: 'POST',
        headers: { Authorization: 'Bearer ops-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'verified campaign' }),
      }),
      { DB: db as unknown as D1Database, OPS_ALERTS_TOKEN: 'ops-secret' },
      'alert-1',
      1_780_000_000_000,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ alert_id: 'alert-1', status: 'confirmed' });
    expect(db.alerts.get('alert-1')).toEqual(expect.objectContaining({ status: 'confirmed', cleared_at: null }));
    expect(db.mitigations[0].cleared_at).toBeNull();
    expect(db.reviews.get('review-active')).toEqual({
      id: 'review-active',
      moderation_state: 'quarantined',
      moderation_updated_at: 100,
    });
    expect(db.triageEvents).toEqual([
      expect.objectContaining({
        alert_id: 'alert-1',
        action: 'confirm',
        reason: 'verified campaign',
        actor: 'ops-token',
        created_at: 1_780_000_000_000,
      }),
    ]);
  });
});

class FakeOpsAlertDb {
  readonly alerts = new Map<string, AlertRow>();
  readonly mitigations: MitigationRow[];
  readonly reviews = new Map<string, { id: string; moderation_state: string; moderation_updated_at: number | null }>();
  readonly triageEvents: TriageRow[] = [];
  readonly logEntries: Array<Record<string, unknown>> = [];
  readonly queries: string[] = [];

  constructor(
    alerts: AlertRow[] = [],
    mitigations: MitigationRow[] = [],
    reviews: Array<{ id: string; moderation_state: string; moderation_updated_at: number | null }> = [],
  ) {
    for (const row of alerts) {
      this.alerts.set(row.id, row);
    }
    this.mitigations = mitigations;
    for (const row of reviews) {
      this.reviews.set(row.id, row);
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
        this.queries.push(sql);
        if (sql.includes('FROM alerts a')) {
          return {
            all: async () => ({
              results: [...this.alerts.values()]
                .filter((row) => row.status === values[0])
                .map((row) => ({
                  ...row,
                  mitigation_count: this.mitigations.filter((mitigation) => (
                    mitigation.alert_id === row.id && mitigation.cleared_at === null
                  )).length || row.mitigation_count || 0,
                }))
                .sort((left, right) => right.created_at - left.created_at),
            }),
          };
        }
        if (sql.includes('SELECT id, status FROM alerts')) {
          return {
            first: async () => {
              const row = this.alerts.get(String(values[0]));
              return row ? { id: row.id, status: row.status } : null;
            },
          };
        }
        if (sql.includes('SELECT review_id, alert_id FROM review_mitigations')) {
          return {
            all: async () => ({
              results: this.mitigations
                .filter((row) => row.alert_id === values[0] && row.cleared_at === null)
                .map((row) => ({ review_id: row.review_id, alert_id: row.alert_id })),
            }),
          };
        }
        if (sql.includes('SELECT seq, leaf_hash FROM log_entries')) {
          return {
            first: async () => null,
          };
        }
        if (sql.includes('UPDATE alerts SET status = ?, cleared_at = ?')) {
          return {
            run: async () => {
              const row = this.alerts.get(String(values[2]));
              if (row) {
                row.status = String(values[0]);
                row.cleared_at = Number(values[1]);
              }
            },
          };
        }
        if (sql.includes('UPDATE alerts SET status = ?, pin_expires_at = NULL WHERE id = ?')) {
          return {
            run: async () => {
              const row = this.alerts.get(String(values[1]));
              if (row) {
                row.status = String(values[0]);
              }
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
              const reviewIds = new Set(
                this.mitigations
                  .filter((row) => row.alert_id === alertId && row.cleared_at === clearedAt)
                  .map((row) => row.review_id),
              );
              for (const reviewId of reviewIds) {
                const review = this.reviews.get(reviewId);
                if (review && review.moderation_state === 'quarantined') {
                  const mitigation = this.mitigations.find((row) => (
                    row.review_id === reviewId &&
                    row.alert_id === alertId &&
                    row.cleared_at === clearedAt
                  ));
                  review.moderation_state = mitigation?.restore_moderation_state || 'visible';
                  review.moderation_updated_at = Number(values[2]);
                }
              }
            },
          };
        }
        if (sql.includes('INSERT INTO alert_triage_events')) {
          return {
            run: async () => {
              this.triageEvents.push({
                id: String(values[0]),
                alert_id: String(values[1]),
                action: String(values[2]),
                reason: values[3] === null ? null : String(values[3]),
                actor: String(values[4]),
                created_at: Number(values[5]),
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
                sig: values[6],
                sig_nonce: values[7],
                content_hash: values[8],
                canon_payload: values[9],
                sig_alg: values[10],
                prev_hash: values[11],
                leaf_hash: values[12],
                created_at: values[13],
                conn_fp: values[14],
                leaf_version: values[15],
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

function alert(overrides: Partial<AlertRow>): AlertRow {
  return {
    id: 'alert',
    type: 'venue.review_bomb',
    subject_type: 'venue',
    subject_id: 'venue-1',
    severity: 'critical',
    dedup_key: 'venue.review_bomb:venue-1:82',
    status: 'open',
    evidence_json: JSON.stringify({ score: 6 }),
    auto_action_taken: 'shadow_downweight',
    delivered_at: null,
    created_at: 100,
    last_seen_at: 100,
    cleared_at: null,
    ...overrides,
  };
}
