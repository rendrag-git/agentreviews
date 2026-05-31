import type { Env } from '../types';
import { parseAlertEvidence, redactAlertEvidence } from '../lib/alert-evidence';
import { buildMitigationClearLogEntries } from '../lib/mitigation-log';
import {
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';

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

interface ActiveMitigationRow {
  review_id: string;
  alert_id: string;
}

const OPS_TOKEN_ACTOR = 'ops-token';
const ALLOWED_ALERT_STATUSES = new Set(['open', 'confirmed', 'dismissed', 'disputed']);

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
    'SELECT review_id, alert_id FROM review_mitigations WHERE alert_id = ? AND cleared_at IS NULL ORDER BY review_id ASC',
  )
    .bind(alertId)
    .all<ActiveMitigationRow>();
  const mitigationRows = activeMitigations.results || [];
  const clearedMitigations = mitigationRows.length;
  const logStatements = await buildMitigationClearLogStatements(env, mitigationRows, body.reason, now);

  await env.DB.batch([
    ...logStatements,
    env.DB.prepare('UPDATE alerts SET status = ?, cleared_at = ? WHERE id = ?')
      .bind('dismissed', now, alertId),
    env.DB.prepare('UPDATE review_mitigations SET cleared_at = ? WHERE alert_id = ? AND cleared_at IS NULL')
      .bind(now, alertId),
    env.DB.prepare(
      `UPDATE reviews
       SET moderation_state = COALESCE((
             SELECT rm.restore_moderation_state
             FROM review_mitigations rm
             WHERE rm.review_id = reviews.id
               AND rm.alert_id = ?
               AND rm.cleared_at = ?
             LIMIT 1
           ), 'visible'),
           moderation_updated_at = ?
       WHERE moderation_state = 'quarantined'
         AND id IN (
           SELECT review_id FROM review_mitigations
           WHERE alert_id = ?
             AND cleared_at = ?
         )`,
    )
      .bind(alertId, now, now, alertId, now),
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

export async function handleConfirmOpsAlert(
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
  if (alert.status === 'confirmed') {
    return opsJson({ alert_id: alertId, status: 'confirmed' });
  }

  const body = await readDismissBody(request);
  if (body instanceof Response) return body;

  await env.DB.batch([
    env.DB.prepare('UPDATE alerts SET status = ? WHERE id = ?')
      .bind('confirmed', alertId),
    env.DB.prepare(
      `INSERT INTO alert_triage_events (id, alert_id, action, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(triageEventId(alertId, now, 'confirm'), alertId, 'confirm', body.reason, OPS_TOKEN_ACTOR, now),
  ]);

  return opsJson({ alert_id: alertId, status: 'confirmed' });
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

function triageEventId(alertId: string, now: number, action = 'dismiss'): string {
  return `triage:${alertId}:${now}:${action}`;
}

async function buildMitigationClearLogStatements(
  env: Env,
  mitigations: ActiveMitigationRow[],
  reason: string | null,
  now: number,
): Promise<D1PreparedStatement[]> {
  if (mitigations.length === 0) return [];
  if (!env.OPERATOR_PRIVATE_KEY || !env.OPERATOR_PUBLIC_KEY) {
    throw new Error('Operator signing key is required to clear mitigations');
  }

  const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
    .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
  const entries = await buildMitigationClearLogEntries({
    env,
    mitigations,
    reason,
    now,
    startSeq: tail ? tail.seq + 1 : 1,
    prevHash: tail ? tail.leaf_hash : GENESIS_PREV_HASH,
  });

  return entries.map((entry) => insertLogEntryStatement(env, entry));
}

function insertLogEntryStatement(env: Env, entry: LogEntry): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO log_entries (
      seq, event_id, event_type, object_type, object_id,
      agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
      prev_hash, leaf_hash, created_at, conn_fp, leaf_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.seq,
      entry.event_id,
      entry.event_type,
      entry.object_type,
      entry.object_id,
      entry.agent_pub,
      entry.sig,
      entry.sig_nonce,
      entry.content_hash,
      entry.canon_payload,
      entry.sig_alg,
      entry.prev_hash,
      entry.leaf_hash,
      entry.created_at,
      null,
      entry.leaf_version ?? 1,
    );
}

function opsJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
