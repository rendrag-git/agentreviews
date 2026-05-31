import type { AlertRow } from './detector-materialization';

export interface DiscordWebhookPayload {
  content: string;
  embeds: Array<{
    title: string;
    color: number;
    fields: Array<{
      name: string;
      value: string;
      inline: boolean;
    }>;
  }>;
}

export interface AlertDeliveryResult {
  attempted: number;
  delivered: number;
  skipped: number;
}

export type AlertDeliveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DeliverDiscordAlertsInput {
  db: D1Database;
  webhookUrl?: string;
  alerts: AlertRow[];
  now: number;
  cooldownMs?: number;
  fetcher?: AlertDeliveryFetch;
}

const PRIVATE_EVIDENCE_KEYS = new Set([
  'conn_fp',
  'suspect_review_ids',
  'suspect_action_ids',
]);
const DEFAULT_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function deliverDiscordAlerts(input: DeliverDiscordAlertsInput): Promise<AlertDeliveryResult> {
  if (input.alerts.length === 0) {
    return { attempted: 0, delivered: 0, skipped: 0 };
  }
  if (!input.webhookUrl) {
    return { attempted: 0, delivered: 0, skipped: input.alerts.length };
  }

  const fetcher = input.fetcher ?? fetch;
  const cooldownMs = input.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  const result: AlertDeliveryResult = { attempted: 0, delivered: 0, skipped: 0 };

  for (const alert of input.alerts) {
    result.attempted += 1;
    const delivery = await input.db.prepare(
      'SELECT delivered_at FROM alerts WHERE dedup_key = ?',
    )
      .bind(alert.dedup_key)
      .first<{ delivered_at: number | null }>();
    const deliveredAt = delivery?.delivered_at ?? null;
    if (deliveredAt !== null && input.now - deliveredAt < cooldownMs) {
      result.skipped += 1;
      continue;
    }

    try {
      const response = await fetcher(input.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildDiscordAlertPayload(alert)),
      });
      if (!response.ok) {
        result.skipped += 1;
        continue;
      }
    } catch {
      result.skipped += 1;
      continue;
    }

    await input.db.prepare(
      'UPDATE alerts SET delivered_at = ? WHERE dedup_key = ?',
    )
      .bind(input.now, alert.dedup_key)
      .run();
    result.delivered += 1;
  }

  return result;
}

export function buildDiscordAlertPayload(alert: AlertRow): DiscordWebhookPayload {
  const evidence = parseEvidence(alert.evidence_json);
  const fields = [
    { name: 'Subject', value: `${alert.subject_type}:${alert.subject_id}`, inline: true },
    { name: 'Auto action', value: alert.auto_action_taken || 'none', inline: true },
    ...Object.entries(evidence)
      .filter(([key]) => !PRIVATE_EVIDENCE_KEYS.has(key))
      .map(([key, value]) => ({
        name: key,
        value: String(value),
        inline: true,
      })),
  ];

  return {
    content: `[${alert.severity}] ${alert.type} on ${alert.subject_type}:${alert.subject_id}`,
    embeds: [{
      title: alert.type,
      color: alert.severity === 'critical' ? 0xff4757 : 0xffb020,
      fields,
    }],
  };
}

function parseEvidence(evidenceJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(evidenceJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
