import {
  detectDispatchRings,
  minhashSignature,
  shingleCount,
  type DispatchRingReview,
  type DispatchRingDetection,
} from './dispatch-rings';
import {
  detectAgentTargeting,
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
  dispatchReviews?: DispatchRingReview[];
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

export interface DispatchRingRow {
  id: string;
  venue_id: string;
  status: string;
  severity: string;
  score: number;
  evidence_json: string;
  detected_at: number;
  last_seen_at: number;
}

export interface RingMemberRow {
  ring_id: string;
  agent_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ReviewSimhashRow {
  review_id: string;
  minhash_json: string;
  shingle_count: number;
  updated_at: number;
}

export interface DetectorMaterializationPlan {
  detector: string;
  next_cursor_seq: number;
  anomalyScores: AnomalyScoreRow[];
  alerts: AlertRow[];
  reviewMitigations: ReviewMitigationRow[];
  rings?: DispatchRingRow[];
  ringMembers?: RingMemberRow[];
  reviewSimhashes?: ReviewSimhashRow[];
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
  const agentTargetingDetections = detectAgentTargeting({
    now: input.now,
    windowMs: input.windowMs,
    actions: candidateActions,
  });
  const dispatchDetections = detectDispatchRings({
    now: input.now,
    reviews: input.dispatchReviews ?? [],
  });

  const anomalyScores: AnomalyScoreRow[] = [];
  const alerts: AlertRow[] = [];
  const reviewMitigations: ReviewMitigationRow[] = [];
  const rings: DispatchRingRow[] = [];
  const ringMembers: RingMemberRow[] = [];
  const reviewSimhashes = planReviewSimhashes(input.dispatchReviews ?? [], input.now);

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

  for (const detection of agentTargetingDetections) {
    const evidenceJson = JSON.stringify({
      ...detection.evidence,
      suspect_action_ids: detection.suspect_action_ids,
      suspect_review_ids: detection.suspect_review_ids,
      venue_ids: detection.venue_ids,
    });
    const dedupKey = `${detection.type}:${detection.target_agent_id}:${sixHourBucket(input.now)}`;
    const alertId = dedupKey;
    anomalyScores.push({
      id: ulid(),
      type: detection.type,
      subject_type: 'agent',
      subject_id: detection.target_agent_id,
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
      subject_type: 'agent',
      subject_id: detection.target_agent_id,
      severity: detection.severity,
      dedup_key: dedupKey,
      status: 'open',
      evidence_json: evidenceJson,
      auto_action_taken: 'targeted_agent_watch',
      created_at: input.now,
      last_seen_at: input.now,
    });
  }

  for (const detection of dispatchDetections) {
    const evidenceJson = JSON.stringify({
      ...detection.evidence,
      member_count: detection.member_agent_ids.length,
      suspect_review_ids: detection.suspect_review_ids,
      suspected_ring_id: detection.ring_id,
    });
    const dedupKey = `${detection.type}:${detection.ring_id}:${sixHourBucket(input.now)}`;
    anomalyScores.push(anomalyScoreForDispatch(detection, evidenceJson, input.now));
    alerts.push({
      id: dedupKey,
      type: detection.type,
      subject_type: 'ring',
      subject_id: detection.ring_id,
      severity: detection.severity,
      dedup_key: dedupKey,
      status: 'open',
      evidence_json: evidenceJson,
      auto_action_taken: 'cluster_downrank',
      created_at: input.now,
      last_seen_at: input.now,
    });
    rings.push({
      id: detection.ring_id,
      venue_id: detection.venue_id,
      status: 'active',
      severity: detection.severity,
      score: detection.score,
      evidence_json: evidenceJson,
      detected_at: input.now,
      last_seen_at: input.now,
    });
    for (const agentId of detection.member_agent_ids) {
      ringMembers.push({
        ring_id: detection.ring_id,
        agent_id: agentId,
        first_seen_at: input.now,
        last_seen_at: input.now,
      });
    }
  }

  return {
    detector: input.detector,
    next_cursor_seq: nextCursor,
    anomalyScores,
    alerts,
    reviewMitigations,
    rings,
    ringMembers,
    reviewSimhashes,
  };
}

function emptyPlan(detector: string, nextCursor: number): DetectorMaterializationPlan {
  return {
    detector,
    next_cursor_seq: nextCursor,
    anomalyScores: [],
    alerts: [],
    reviewMitigations: [],
    rings: [],
    ringMembers: [],
    reviewSimhashes: [],
  };
}

function anomalyScoreForDispatch(
  detection: DispatchRingDetection,
  evidenceJson: string,
  now: number,
): AnomalyScoreRow {
  return {
    id: `${detection.ring_id}:score:${now}`,
    type: detection.type,
    subject_type: 'ring',
    subject_id: detection.ring_id,
    severity: detection.severity,
    score: detection.score,
    window_start: now,
    window_end: now,
    evidence_json: evidenceJson,
    status: 'open',
    created_at: now,
  };
}

function planReviewSimhashes(reviews: DispatchRingReview[], now: number): ReviewSimhashRow[] {
  return reviews
    .filter((review) => review.body && review.body.trim().length > 0)
    .map((review) => ({
      review_id: review.id,
      minhash_json: JSON.stringify(minhashSignature(review.body ?? '')),
      shingle_count: shingleCount(review.body ?? ''),
      updated_at: now,
    }));
}

function sixHourBucket(timestamp: number): number {
  return Math.floor(timestamp / (6 * 60 * 60 * 1000));
}
