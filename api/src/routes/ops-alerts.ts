import type { Env } from '../types';
import { parseAlertEvidence, redactAlertEvidence } from '../lib/alert-evidence';

interface OpsAlertRow {
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
  mitigation_count: number;
}

const OPS_TOKEN_ACTOR = 'ops-token';
const ALLOWED_ALERT_STATUSES = new Set(['open', 'dismissed']);

export async function handleListOpsAlerts(request: Request, env: Env): Promise<Response> {
  const auth = requireOpsAuth(request, env);
  if (auth) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  if (!ALLOWED_ALERT_STATUSES.has(status)) {
    return opsJson({ error: 'Unsupported alert status' }, 400);
  }

  const result = await env.DB.prepare(
    `SELECT a.*,
            COUNT(rm.review_id) AS mitigation_count
     FROM alerts a
     LEFT JOIN review_mitigations rm
       ON rm.alert_id = a.id AND rm.cleared_at IS NULL
     WHERE a.status = ?
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
  )
    .bind(status)
    .all<OpsAlertRow>();

  const alerts = (result.results || []).map((row) => ({
    id: row.id,
    type: row.type,
    subject_type: row.subject_type,
    subject_id: null,
    severity: row.severity,
    status: row.status,
    evidence: redactAlertEvidence(parseAlertEvidence(row.evidence_json)),
    auto_action_taken: row.auto_action_taken,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    cleared_at: row.cleared_at,
    active_mitigation_count: Number(row.mitigation_count || 0),
  }));

  return opsJson({ alerts, count: alerts.length });
}

export async function handleDismissOpsAlert(
  request: Request,
  env: Env,
  alertId: string,
  now = Date.now(),
): Promise<Response> {
  const auth = requireOpsAuth(request, env);
  if (auth) return auth;

  const alert = await env.DB.prepare('SELECT id, status FROM alerts WHERE id = ?')
    .bind(alertId)
    .first<{ id: string; status: string }>();
  if (!alert) {
    return opsJson({ error: 'Alert not found' }, 404);
  }
  if (alert.status === 'dismissed') {
    return opsJson({
      alert_id: alertId,
      status: 'dismissed',
      cleared_mitigations: 0,
    });
  }

  const body = await readDismissBody(request);
  if (body instanceof Response) return body;

  const activeMitigations = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM review_mitigations WHERE alert_id = ? AND cleared_at IS NULL',
  )
    .bind(alertId)
    .first<{ count: number }>();
  const clearedMitigations = Number(activeMitigations?.count || 0);

  await env.DB.batch([
    env.DB.prepare('UPDATE alerts SET status = ?, cleared_at = ? WHERE id = ?')
      .bind('dismissed', now, alertId),
    env.DB.prepare('UPDATE review_mitigations SET cleared_at = ? WHERE alert_id = ? AND cleared_at IS NULL')
      .bind(now, alertId),
    env.DB.prepare(
      `INSERT INTO alert_triage_events (id, alert_id, action, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(triageEventId(alertId, now), alertId, 'dismiss', body.reason, OPS_TOKEN_ACTOR, now),
  ]);

  return opsJson({
    alert_id: alertId,
    status: 'dismissed',
    cleared_mitigations: clearedMitigations,
  });
}

function requireOpsAuth(request: Request, env: Env): Response | null {
  if (!env.OPS_ALERTS_TOKEN) {
    return opsJson({ error: 'Ops authentication is not configured' }, 503);
  }
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token !== env.OPS_ALERTS_TOKEN) {
    return opsJson({ error: 'Ops authentication required' }, 401);
  }
  return null;
}

async function readDismissBody(request: Request): Promise<{ reason: string | null } | Response> {
  const text = await request.text();
  if (!text.trim()) return { reason: null };
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : null;
    return { reason };
  } catch {
    return opsJson({ error: 'Invalid JSON body' }, 400);
  }
}

function triageEventId(alertId: string, now: number): string {
  return `triage:${alertId}:${now}:dismiss`;
}

function opsJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
