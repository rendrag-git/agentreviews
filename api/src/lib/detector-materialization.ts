import {
  detectReviewActionSwarms,
  detectVenueReviewCampaigns,
  type ReviewActionEvent,
  type VenueCampaignReview,
} from './detectors';
import { ulid } from './ulid';

export interface DetectorLogEntry {
  seq: number;
  event_type: string;
  object_id: string;
  created_at: number;
}

export interface DetectorMaterializationInput {
  detector: string;
  cursor_seq: number;
  now: number;
  logEntries: DetectorLogEntry[];
  reviews: VenueCampaignReview[];
  reviewActions?: ReviewActionEvent[];
  windowMs?: number;
}

export interface AnomalyScoreRow {
  id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  severity: string;
  score: number;
  window_start: number;
  window_end: number;
  evidence_json: string;
  status: string;
  created_at: number;
}

export interface AlertRow {
  id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  severity: string;
  dedup_key: string;
  status: string;
  evidence_json: string;
  auto_action_taken: string;
  created_at: number;
  last_seen_at: number;
}

export interface ReviewMitigationRow {
  review_id: string;
  alert_id: string;
  venue_id: string;
  multiplier: number;
  reason: string;
  created_at: number;
}

export interface DetectorMaterializationPlan {
  detector: string;
  next_cursor_seq: number;
  anomalyScores: AnomalyScoreRow[];
  alerts: AlertRow[];
  reviewMitigations: ReviewMitigationRow[];
}

export function planDetectorMaterialization(input: DetectorMaterializationInput): DetectorMaterializationPlan {
  const newEntries = input.logEntries
    .filter((entry) => entry.seq > input.cursor_seq)
    .sort((left, right) => left.seq - right.seq);
  const nextCursor = newEntries.at(-1)?.seq ?? input.cursor_seq;
  if (newEntries.length === 0) {
    return emptyPlan(input.detector, nextCursor);
  }
  const entries = newEntries.filter((entry) => entry.event_type === 'review.create');
  const actionEntries = newEntries.filter((entry) => entry.event_type === 'review.flag' || entry.event_type === 'review.vote');

  const newReviewIds = new Set(entries.map((entry) => entry.object_id));
  const affectedVenueIds = new Set(
    input.reviews
      .filter((review) => newReviewIds.has(review.id))
      .map((review) => review.venue_id),
  );
  const candidateReviews = input.reviews.filter((review) => affectedVenueIds.has(review.venue_id));
  const detections = detectVenueReviewCampaigns({
    now: input.now,
    windowMs: input.windowMs,
    reviews: candidateReviews,
  });
  const newActionIds = new Set(actionEntries.map((entry) => entry.object_id));
  const affectedReviewIds = new Set(
    (input.reviewActions ?? [])
      .filter((action) => newActionIds.has(action.id))
      .map((action) => action.review_id),
  );
  const candidateActions = (input.reviewActions ?? [])
    .filter((action) => affectedReviewIds.has(action.review_id));
  const actionDetections = detectReviewActionSwarms({
    now: input.now,
    windowMs: input.windowMs,
    actions: candidateActions,
  });

  const anomalyScores: AnomalyScoreRow[] = [];
  const alerts: AlertRow[] = [];
  const reviewMitigations: ReviewMitigationRow[] = [];

  for (const detection of detections) {
    const evidenceJson = JSON.stringify({
      ...detection.evidence,
      suspect_review_ids: detection.suspect_review_ids,
    });
    const dedupKey = `${detection.type}:${detection.venue_id}:${sixHourBucket(input.now)}`;
    const alertId = dedupKey;
    anomalyScores.push({
      id: ulid(),
      type: detection.type,
      subject_type: 'venue',
      subject_id: detection.venue_id,
      severity: detection.severity,
      score: detection.score,
      window_start: detection.window_start,
      window_end: detection.window_end,
      evidence_json: evidenceJson,
      status: 'open',
      created_at: input.now,
    });
    alerts.push({
      id: alertId,
      type: detection.type,
      subject_type: 'venue',
      subject_id: detection.venue_id,
      severity: detection.severity,
      dedup_key: dedupKey,
      status: 'open',
      evidence_json: evidenceJson,
      auto_action_taken: 'shadow_downweight',
      created_at: input.now,
      last_seen_at: input.now,
    });
    for (const reviewId of detection.suspect_review_ids) {
      reviewMitigations.push({
        review_id: reviewId,
        alert_id: alertId,
        venue_id: detection.venue_id,
        multiplier: detection.shadow_multiplier,
        reason: detection.type,
        created_at: input.now,
      });
    }
  }

  for (const detection of actionDetections) {
    const evidenceJson = JSON.stringify({
      ...detection.evidence,
      suspect_action_ids: detection.suspect_action_ids,
    });
    const dedupKey = `${detection.type}:${detection.review_id}:${sixHourBucket(input.now)}`;
    const alertId = dedupKey;
    anomalyScores.push({
      id: ulid(),
      type: detection.type,
      subject_type: 'review',
      subject_id: detection.review_id,
      severity: detection.severity,
      score: detection.score,
      window_start: detection.window_start,
      window_end: detection.window_end,
      evidence_json: evidenceJson,
      status: 'open',
      created_at: input.now,
    });
    alerts.push({
      id: alertId,
      type: detection.type,
      subject_type: 'review',
      subject_id: detection.review_id,
      severity: detection.severity,
      dedup_key: dedupKey,
      status: 'open',
      evidence_json: evidenceJson,
      auto_action_taken: detection.type === 'review.flag_swarm' ? 'flag_swarm_gate' : 'vote_swarm_watch',
      created_at: input.now,
      last_seen_at: input.now,
    });
  }

  return {
    detector: input.detector,
    next_cursor_seq: nextCursor,
    anomalyScores,
    alerts,
    reviewMitigations,
  };
}

function emptyPlan(detector: string, nextCursor: number): DetectorMaterializationPlan {
  return {
    detector,
    next_cursor_seq: nextCursor,
    anomalyScores: [],
    alerts: [],
    reviewMitigations: [],
  };
}

function sixHourBucket(timestamp: number): number {
  return Math.floor(timestamp / (6 * 60 * 60 * 1000));
}
