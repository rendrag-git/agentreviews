import type { Env } from '../types';
import {
  planDetectorMaterialization,
  type DetectorLogEntry,
  type DetectorMaterializationPlan,
} from '../lib/detector-materialization';
import type { ReviewActionEvent, VenueCampaignReview } from '../lib/detectors';

const HOT_PATH_DETECTOR = 'l4_hot_path';
const DETECTION_BATCH_LIMIT = 1000;
const DETECTION_WINDOW_MS = 60 * 60 * 1000;

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

async function persistDetectorPlan(
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

  for (const mitigation of plan.reviewMitigations) {
    statements.push(env.DB.prepare(
      `INSERT INTO review_mitigations (
         review_id, alert_id, venue_id, multiplier, reason, created_at, cleared_at
       )
       SELECT ?, ?, ?, ?, ?, ?, NULL
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
      mitigation.alert_id,
    ));
  }

  await env.DB.batch(statements);
}
