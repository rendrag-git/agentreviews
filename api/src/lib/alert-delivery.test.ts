import { describe, expect, it } from 'vitest';
import { buildDiscordAlertPayload, deliverDiscordAlerts } from './alert-delivery';
import type { AlertRow } from './detector-materialization';

const alert: AlertRow = {
  id: 'venue.review_bomb:venue-1:82',
  type: 'venue.review_bomb',
  subject_type: 'venue',
  subject_id: 'venue-1',
  severity: 'critical',
  dedup_key: 'venue.review_bomb:venue-1:82',
  status: 'open',
  evidence_json: JSON.stringify({
    review_count: 8,
    frac_low_trust: 1,
    max_conn_fp_count: 8,
    conn_fp: 'raw-private-fingerprint',
    suspect_review_ids: ['review-a', 'review-b'],
  }),
  auto_action_taken: 'shadow_downweight',
  created_at: 1_780_000_000_000,
  last_seen_at: 1_780_000_000_000,
};

describe('alert delivery', () => {
  it('builds a Discord payload with alert context and sanitized evidence', () => {
    const payload = buildDiscordAlertPayload(alert);

    expect(payload.content).toContain('critical');
    expect(payload.embeds[0].title).toBe('venue.review_bomb');
    expect(payload.embeds[0].fields).toEqual(expect.arrayContaining([
      { name: 'Subject', value: 'venue:venue-1', inline: true },
      { name: 'Auto action', value: 'shadow_downweight', inline: true },
      { name: 'review_count', value: '8', inline: true },
      { name: 'max_conn_fp_count', value: '8', inline: true },
    ]));
    expect(JSON.stringify(payload)).not.toContain('raw-private-fingerprint');
    expect(JSON.stringify(payload)).not.toContain('suspect_review_ids');
    expect(payload.embeds[0].fields.map((field) => field.name)).not.toContain('conn_fp');
  });

  it('persists Discord delivery cooldown by alert dedup key', async () => {
    const db = new FakeAlertDeliveryDb([alert]);
    const calls: unknown[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    };

    const first = await deliverDiscordAlerts({
      db: db as unknown as D1Database,
      webhookUrl: 'https://discord.example/webhook',
      alerts: [alert],
      now: alert.created_at,
      cooldownMs: 60_000,
      fetcher,
    });
    const second = await deliverDiscordAlerts({
      db: db as unknown as D1Database,
      webhookUrl: 'https://discord.example/webhook',
      alerts: [alert],
      now: alert.created_at + 30_000,
      cooldownMs: 60_000,
      fetcher,
    });
    const third = await deliverDiscordAlerts({
      db: db as unknown as D1Database,
      webhookUrl: 'https://discord.example/webhook',
      alerts: [alert],
      now: alert.created_at + 61_000,
      cooldownMs: 60_000,
      fetcher,
    });
    const missingWebhook = await deliverDiscordAlerts({
      db: db as unknown as D1Database,
      webhookUrl: undefined,
      alerts: [alert],
      now: alert.created_at + 122_000,
      cooldownMs: 60_000,
      fetcher,
    });

    expect(first).toEqual({ attempted: 1, delivered: 1, skipped: 0 });
    expect(second).toEqual({ attempted: 1, delivered: 0, skipped: 1 });
    expect(third).toEqual({ attempted: 1, delivered: 1, skipped: 0 });
    expect(missingWebhook).toEqual({ attempted: 0, delivered: 0, skipped: 1 });
    expect(calls).toHaveLength(2);
    expect(db.deliveredAt(alert.dedup_key)).toBe(alert.created_at + 61_000);
  });
});

class FakeAlertDeliveryDb {
  private rows = new Map<string, AlertRow & { delivered_at: number | null }>();

  constructor(alerts: AlertRow[]) {
    for (const row of alerts) {
      this.rows.set(row.dedup_key, { ...row, delivered_at: null });
    }
  }

  prepare(sql: string): { bind: (...values: unknown[]) => { first?: () => Promise<unknown>; run?: () => Promise<void> } } {
    return {
      bind: (...values: unknown[]) => {
        if (sql.includes('SELECT delivered_at')) {
          return {
            first: async () => {
              const row = this.rows.get(String(values[0]));
              return row ? { delivered_at: row.delivered_at } : null;
            },
          };
        }
        if (sql.includes('UPDATE alerts')) {
          return {
            run: async () => {
              const row = this.rows.get(String(values[1]));
              if (row) row.delivered_at = Number(values[0]);
            },
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }

  deliveredAt(dedupKey: string): number | null {
    return this.rows.get(dedupKey)?.delivered_at ?? null;
  }
}
