import type { Env } from '../types';
import { buildMitigationApplyLogEntries, buildMitigationClearLogEntries } from '../lib/mitigation-log';
import {
  planDetectorMaterialization,
  type DetectorLogEntry,
  type DetectorMaterializationPlan,
} from '../lib/detector-materialization';
import type { ReviewActionEvent, VenueCampaignReview } from '../lib/detectors';
import { GENESIS_PREV_HASH, type LogEntry } from '../lib/transparency-log';

const HOT_PATH_DETECTOR = 'l4_hot_path';
const DETECTION_BATCH_LIMIT = 1000;
const DETECTION_WINDOW_MS = 60 * 60 * 1000;
const RECOVERY_CLEAR_THRESHOLD = 2.5;
const RECOVERY_QUIET_MS = 24 * 60 * 60 * 1000;
const RECOVERY_SCORE_HALF_LIFE_MS = 14 * 60 * 60 * 1000;
const RECOVERY_PIN_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_AUTO_CLEAR_REASON = 'auto_clear:score_below_threshold';

interface MitigationRecoveryCandidate {
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

export async function runDetectors(env: Env, epoch = Date.now()): Promise<DetectorMaterializationPlan> {
  const state = await env.DB.prepare('SELECT cursor_seq FROM detector_state WHERE detector = ?')
    .bind(HOT_PATH_DETECTOR)
    .first<{ cursor_seq: number }>();
  const cursorSeq = state?.cursor_seq ?? 0;
  const logEntries = await env.DB.prepare(
    `SELECT seq, event_type, object_id, created_at
     FROM log_entries
     WHERE seq > ?
     ORDER BY seq ASC
     LIMIT ?`,
  )
    .bind(cursorSeq, DETECTION_BATCH_LIMIT)
    .all<DetectorLogEntry>();
  const entries = logEntries.results || [];
  const reviewIds = entries
    .filter((entry) => entry.event_type === 'review.create')
    .map((entry) => entry.object_id);
  const actionIds = entries
    .filter((entry) => entry.event_type === 'review.flag' || entry.event_type === 'review.vote')
    .map((entry) => entry.object_id);
  const reviews = reviewIds.length > 0
    ? await loadDetectionReviews(env, reviewIds, epoch - DETECTION_WINDOW_MS)
    : [];
  const reviewActions = actionIds.length > 0
    ? await loadDetectionReviewActions(env, actionIds, epoch - DETECTION_WINDOW_MS)
    : [];

  const plan = planDetectorMaterialization({
    detector: HOT_PATH_DETECTOR,
    cursor_seq: cursorSeq,
    now: epoch,
    windowMs: DETECTION_WINDOW_MS,
    logEntries: entries,
    reviews,
    reviewActions,
  });

  await persistDetectorPlan(env, plan, epoch);
  return plan;
}

export async function runMitigationRecovery(
  env: Env,
  epoch = Date.now(),
): Promise<{ scanned: number; cleared: number }> {
  const candidatesResult = await env.DB.prepare(
    `SELECT
       a.id AS alert_id,
       rm.review_id,
       rm.venue_id,
       a.status,
       a.type,
       a.subject_type,
       a.subject_id,
       a.evidence_json,
       latest.score AS latest_score,
       a.last_seen_at,
       a.created_at,
       rm.restore_moderation_state,
       rm.cleared_at
     FROM alerts a
     JOIN review_mitigations rm
       ON rm.alert_id = a.id
      AND rm.cleared_at IS NULL
     LEFT JOIN anomaly_scores latest
       ON latest.id = (
         SELECT s.id
         FROM anomaly_scores s
         WHERE s.type = a.type
           AND s.subject_type = a.subject_type
           AND s.subject_id = a.subject_id
         ORDER BY s.created_at DESC
         LIMIT 1
       )
     WHERE a.status = 'open'
       AND a.cleared_at IS NULL
       AND (a.pin_expires_at IS NULL OR a.pin_expires_at <= ?)
     ORDER BY a.id ASC, rm.review_id ASC`,
  )
    .bind(epoch)
    .all<MitigationRecoveryCandidate>();
  const candidates = candidatesResult.results || [];
  const eligible = candidates.filter((candidate) => shouldAutoClearMitigation(candidate, epoch));
  if (eligible.length === 0) {
    return { scanned: candidates.length, cleared: 0 };
  }

  const statements: D1PreparedStatement[] = [];
  const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
    .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
  const clearEntries = await buildMitigationClearLogEntries({
    env,
    mitigations: eligible.map((candidate) => ({
      review_id: candidate.review_id,
      alert_id: candidate.alert_id,
    })),
    reason: RECOVERY_AUTO_CLEAR_REASON,
    now: epoch,
    startSeq: tail ? tail.seq + 1 : 1,
    prevHash: tail ? tail.leaf_hash : GENESIS_PREV_HASH,
  });
  for (const entry of clearEntries) {
    statements.push(insertLogEntryStatement(env, entry));
  }

  const eligibleByAlert = groupRecoveryCandidatesByAlert(eligible);
  const pinnedUntil = epoch + RECOVERY_PIN_MS;
  for (const [alertId, alertCandidates] of eligibleByAlert) {
    const score = recoveryScore(alertCandidates[0], epoch);
    statements.push(
      env.DB.prepare('UPDATE review_mitigations SET cleared_at = ? WHERE alert_id = ? AND cleared_at IS NULL')
        .bind(epoch, alertId),
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
        .bind(alertId, epoch, epoch, alertId, epoch),
      env.DB.prepare('UPDATE alerts SET status = ?, cleared_at = ?, pin_expires_at = ? WHERE id = ? AND status = ?')
        .bind('dismissed', epoch, pinnedUntil, alertId, 'open'),
      env.DB.prepare(
        `INSERT INTO alert_triage_events (id, alert_id, action, reason, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          recoveryEventId(alertId, epoch),
          alertId,
          'auto_clear',
          `${RECOVERY_AUTO_CLEAR_REASON};score=${score};threshold=${RECOVERY_CLEAR_THRESHOLD};pin_expires_at=${pinnedUntil}`,
          'system',
          epoch,
        ),
    );
  }

  await env.DB.batch(statements);
  return { scanned: candidates.length, cleared: eligible.length };
}

async function loadDetectionReviewActions(
  env: Env,
  actionIds: string[],
  windowStart: number,
): Promise<ReviewActionEvent[]> {
  const actionPlaceholders = actionIds.map(() => '?').join(', ');
  const affectedReviews = await env.DB.prepare(
    `SELECT f.review_id, r.agent_id AS target_agent_id
     FROM flags f
     JOIN reviews r ON r.id = f.review_id
     WHERE f.action_id IN (${actionPlaceholders})
     UNION
     SELECT v.review_id, r.agent_id AS target_agent_id
     FROM votes v
     JOIN reviews r ON r.id = v.review_id
     WHERE v.action_id IN (${actionPlaceholders})`,
  )
    .bind(...actionIds, ...actionIds)
    .all<{ review_id: string; target_agent_id: string }>();
  const affectedRows = affectedReviews.results || [];
  const reviewIds = [...new Set(affectedRows.map((row) => row.review_id))];
  const targetAgentIds = [...new Set(affectedRows.map((row) => row.target_agent_id))];
  if (reviewIds.length === 0 && targetAgentIds.length === 0) return [];

  const scopeClauses: string[] = [];
  const scopeValues: string[] = [];
  if (reviewIds.length > 0) {
    scopeClauses.push(`r.id IN (${reviewIds.map(() => '?').join(', ')})`);
    scopeValues.push(...reviewIds);
  }
  if (targetAgentIds.length > 0) {
    scopeClauses.push(`r.agent_id IN (${targetAgentIds.map(() => '?').join(', ')})`);
    scopeValues.push(...targetAgentIds);
  }
  const actionScopeSql = scopeClauses.join(' OR ');

  const flags = await env.DB.prepare(
    `SELECT
       f.action_id AS id,
       f.review_id,
       r.agent_id AS target_agent_id,
       r.venue_id,
       f.agent_id,
       'review.flag' AS event_type,
       f.created_at,
       a.created_at AS agent_created_at,
       a.trust_score AS actor_trust,
       f.signed,
       le.conn_fp
     FROM flags f
     JOIN reviews r ON r.id = f.review_id
     JOIN agents a ON a.id = f.agent_id
     LEFT JOIN log_entries le ON le.seq = f.log_seq
     WHERE (${actionScopeSql})
       AND f.created_at >= ?
       AND f.signed = 1
       AND f.action_id IS NOT NULL`,
  )
    .bind(...scopeValues, windowStart)
    .all<ReviewActionEvent>();

  const votes = await env.DB.prepare(
    `SELECT
       v.action_id AS id,
       v.review_id,
       r.agent_id AS target_agent_id,
       r.venue_id,
       v.agent_id,
       'review.vote' AS event_type,
       v.vote,
       v.created_at,
       a.created_at AS agent_created_at,
       a.trust_score AS actor_trust,
       v.signed,
       le.conn_fp
     FROM votes v
     JOIN reviews r ON r.id = v.review_id
     JOIN agents a ON a.id = v.agent_id
     LEFT JOIN log_entries le ON le.seq = v.log_seq
     WHERE (${actionScopeSql})
       AND v.created_at >= ?
       AND v.signed = 1
       AND v.action_id IS NOT NULL`,
  )
    .bind(...scopeValues, windowStart)
    .all<ReviewActionEvent>();

  return [
    ...(flags.results || []),
    ...(votes.results || []),
  ].map((action) => ({
    ...action,
    signed: Boolean(action.signed),
  }));
}

async function loadDetectionReviews(
  env: Env,
  reviewIds: string[],
  windowStart: number,
): Promise<VenueCampaignReview[]> {
  const reviewPlaceholders = reviewIds.map(() => '?').join(', ');
  const affectedVenues = await env.DB.prepare(
    `SELECT DISTINCT venue_id
     FROM reviews
     WHERE id IN (${reviewPlaceholders})`,
  )
    .bind(...reviewIds)
    .all<{ venue_id: string }>();
  const venueIds = (affectedVenues.results || []).map((row) => row.venue_id);
  if (venueIds.length === 0) return [];

  const venuePlaceholders = venueIds.map(() => '?').join(', ');
  const reviews = await env.DB.prepare(
    `SELECT
       r.id,
       r.venue_id,
       r.agent_id,
       r.rating,
       r.created_at AS review_created_at,
       a.created_at AS agent_created_at,
       a.trust_score AS author_trust
     FROM reviews r
     JOIN agents a ON a.id = r.agent_id
     WHERE r.venue_id IN (${venuePlaceholders})
       AND r.created_at >= ?
       AND r.erased_at IS NULL
       AND r.moderation_state IN ('visible', 'soft_hidden')
     ORDER BY r.venue_id ASC, r.id ASC`,
  )
    .bind(...venueIds, windowStart)
    .all<VenueCampaignReview>();

  return reviews.results || [];
}

function shouldAutoClearMitigation(candidate: MitigationRecoveryCandidate, epoch: number): boolean {
  return epoch - candidate.last_seen_at >= RECOVERY_QUIET_MS &&
    recoveryScore(candidate, epoch) < RECOVERY_CLEAR_THRESHOLD;
}

function recoveryScore(candidate: MitigationRecoveryCandidate, epoch: number): number {
  const latestScore = Number.isFinite(candidate.latest_score) ? Number(candidate.latest_score) : 0;
  const quietMs = Math.max(0, epoch - candidate.last_seen_at);
  const halfLives = quietMs / RECOVERY_SCORE_HALF_LIFE_MS;
  return round(latestScore * Math.pow(0.5, halfLives));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function groupRecoveryCandidatesByAlert(candidates: MitigationRecoveryCandidate[]): Map<string, MitigationRecoveryCandidate[]> {
  const byAlert = new Map<string, MitigationRecoveryCandidate[]>();
  for (const candidate of candidates) {
    const rows = byAlert.get(candidate.alert_id) ?? [];
    rows.push(candidate);
    byAlert.set(candidate.alert_id, rows);
  }
  return byAlert;
}

function recoveryEventId(alertId: string, epoch: number): string {
  return `recovery:${alertId}:${epoch}:auto_clear`;
}

export async function persistDetectorPlan(
  env: Env,
  plan: DetectorMaterializationPlan,
  epoch: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO detector_state (detector, cursor_seq, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(detector) DO UPDATE
       SET cursor_seq = excluded.cursor_seq,
           updated_at = excluded.updated_at`,
    ).bind(plan.detector, plan.next_cursor_seq, epoch),
  ];

  for (const score of plan.anomalyScores) {
    statements.push(env.DB.prepare(
      `INSERT INTO anomaly_scores (
         id, type, subject_type, subject_id, severity, score,
         window_start, window_end, evidence_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      score.id,
      score.type,
      score.subject_type,
      score.subject_id,
      score.severity,
      score.score,
      score.window_start,
      score.window_end,
      score.evidence_json,
      score.status,
      score.created_at,
    ));
  }

  for (const alert of plan.alerts) {
    statements.push(env.DB.prepare(
      `INSERT INTO alerts (
         id, type, subject_type, subject_id, severity, dedup_key, status,
         evidence_json, auto_action_taken, created_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE
       SET severity = excluded.severity,
           evidence_json = excluded.evidence_json,
           auto_action_taken = excluded.auto_action_taken,
           last_seen_at = excluded.last_seen_at`,
    ).bind(
      alert.id,
      alert.type,
      alert.subject_type,
      alert.subject_id,
      alert.severity,
      alert.dedup_key,
      alert.status,
      alert.evidence_json,
      alert.auto_action_taken,
      alert.created_at,
      alert.last_seen_at,
    ));
  }

  if (plan.reviewMitigations.length > 0) {
    const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
      .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
    const applyEntries = await buildMitigationApplyLogEntries({
      env,
      mitigations: plan.reviewMitigations.map((mitigation) => ({
        review_id: mitigation.review_id,
        alert_id: mitigation.alert_id,
        reason: mitigation.reason,
        multiplier: mitigation.multiplier,
      })),
      now: epoch,
      startSeq: tail ? tail.seq + 1 : 1,
      prevHash: tail ? tail.leaf_hash : GENESIS_PREV_HASH,
    });

    for (const entry of applyEntries) {
      statements.push(insertLogEntryStatement(env, entry));
    }
  }

  const criticalAlertIds = new Set(
    plan.alerts
      .filter((alert) => alert.severity === 'critical')
      .map((alert) => alert.id),
  );

  for (const mitigation of plan.reviewMitigations) {
    const critical = criticalAlertIds.has(mitigation.alert_id);
    statements.push(env.DB.prepare(
      `INSERT INTO review_mitigations (
         review_id, alert_id, venue_id, multiplier, reason, created_at, cleared_at,
         restore_moderation_state
       )
       SELECT ?, ?, ?, ?, ?, ?, NULL,
              CASE
                WHEN ? THEN (SELECT moderation_state FROM reviews WHERE id = ?)
                ELSE NULL
              END
       WHERE EXISTS (
         SELECT 1 FROM alerts
         WHERE id = ?
           AND status = 'open'
           AND cleared_at IS NULL
       )
       ON CONFLICT(review_id) DO UPDATE
       SET alert_id = excluded.alert_id,
           venue_id = excluded.venue_id,
           multiplier = excluded.multiplier,
           reason = excluded.reason,
           created_at = excluded.created_at,
           restore_moderation_state = COALESCE(
             review_mitigations.restore_moderation_state,
             excluded.restore_moderation_state
           ),
           cleared_at = CASE
             WHEN EXISTS (
               SELECT 1 FROM alerts
               WHERE id = excluded.alert_id
                 AND status = 'open'
                 AND cleared_at IS NULL
             )
             THEN NULL
             ELSE review_mitigations.cleared_at
           END`,
    ).bind(
      mitigation.review_id,
      mitigation.alert_id,
      mitigation.venue_id,
      mitigation.multiplier,
      mitigation.reason,
      mitigation.created_at,
      critical ? 1 : 0,
      mitigation.review_id,
      mitigation.alert_id,
    ));
  }

  for (const mitigation of plan.reviewMitigations) {
    if (!criticalAlertIds.has(mitigation.alert_id)) continue;
    statements.push(env.DB.prepare(
      `UPDATE reviews
       SET moderation_state = 'quarantined',
           moderation_updated_at = ?
       WHERE id = ?
         AND moderation_state != 'quarantined'
         AND erased_at IS NULL`,
    ).bind(epoch, mitigation.review_id));
  }

  await env.DB.batch(statements);
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
