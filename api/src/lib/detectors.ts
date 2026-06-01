export type DetectionType = 'venue.review_bomb' | 'venue.astroturf';
export type ReviewActionDetectionType = 'review.flag_swarm' | 'review.vote_swarm';
export type AgentTargetingDetectionType = 'agent.targeted';
export type DetectionSeverity = 'warn' | 'critical';

export interface VenueCampaignReview {
  id: string;
  venue_id: string;
  agent_id: string;
  rating: number;
  review_created_at: number;
  agent_created_at: number;
  author_trust: number | null;
}

export interface VenueCampaignInput {
  now: number;
  reviews: VenueCampaignReview[];
  windowMs?: number;
  expectedReviewsPerWindow?: number;
}

export interface VenueCampaignDetection {
  type: DetectionType;
  severity: DetectionSeverity;
  venue_id: string;
  score: number;
  window_start: number;
  window_end: number;
  suspect_review_ids: string[];
  shadow_multiplier: number;
  evidence: {
    review_count: number;
    avg_rating: number;
    frac_new: number;
    frac_low_trust: number;
    velocity_score: number;
    convergence_score: number;
  };
}

export interface ReviewActionEvent {
  id: string;
  review_id: string;
  target_agent_id?: string | null;
  venue_id?: string | null;
  agent_id: string;
  event_type: 'review.flag' | 'review.vote';
  vote?: number;
  created_at: number;
  agent_created_at: number;
  actor_trust: number | null;
  signed: boolean;
  conn_fp?: string | null;
}

export interface ReviewActionSwarmInput {
  now: number;
  actions: ReviewActionEvent[];
  windowMs?: number;
  expectedActionsPerWindow?: number;
}

export interface ReviewActionSwarmDetection {
  type: ReviewActionDetectionType;
  severity: DetectionSeverity;
  review_id: string;
  score: number;
  window_start: number;
  window_end: number;
  suspect_action_ids: string[];
  evidence: {
    action_count: number;
    frac_new: number;
    frac_low_trust: number;
    distinct_conn_fp_count: number;
    max_conn_fp_count: number;
    velocity_score: number;
    coordination_score: number;
  };
}

export interface AgentTargetingDetection {
  type: AgentTargetingDetectionType;
  severity: DetectionSeverity;
  target_agent_id: string;
  score: number;
  window_start: number;
  window_end: number;
  suspect_action_ids: string[];
  suspect_review_ids: string[];
  venue_ids: string[];
  evidence: {
    action_count: number;
    attacker_count: number;
    affected_review_count: number;
    affected_venue_count: number;
    frac_new: number;
    frac_low_trust: number;
    max_conn_fp_count: number;
    targeting_score: number;
  };
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_EXPECTED_REVIEWS = 1;
const DEFAULT_EXPECTED_ACTIONS = 1;
const NEW_AGENT_AGE_MS = 24 * 60 * 60 * 1000;
const LOW_TRUST_THRESHOLD = 0.1;

export function detectVenueReviewCampaigns(input: VenueCampaignInput): VenueCampaignDetection[] {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const expected = Math.max(0.1, input.expectedReviewsPerWindow ?? DEFAULT_EXPECTED_REVIEWS);
  const windowStart = input.now - windowMs;
  const byVenue = new Map<string, VenueCampaignReview[]>();

  for (const review of input.reviews) {
    if (review.review_created_at < windowStart || review.review_created_at > input.now) continue;
    const reviews = byVenue.get(review.venue_id) ?? [];
    reviews.push(review);
    byVenue.set(review.venue_id, reviews);
  }

  return [...byVenue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([venueId, reviews]) => detectVenue(venueId, reviews, input.now, windowStart, expected));
}

export function detectReviewActionSwarms(input: ReviewActionSwarmInput): ReviewActionSwarmDetection[] {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const expected = Math.max(0.1, input.expectedActionsPerWindow ?? DEFAULT_EXPECTED_ACTIONS);
  const windowStart = input.now - windowMs;
  const byReviewAndType = new Map<string, ReviewActionEvent[]>();

  for (const action of input.actions) {
    if (!action.signed) continue;
    if (action.created_at < windowStart || action.created_at > input.now) continue;
    if (action.event_type === 'review.vote' && action.vote !== -1) continue;
    const key = `${action.review_id}:${action.event_type}`;
    const actions = byReviewAndType.get(key) ?? [];
    actions.push(action);
    byReviewAndType.set(key, actions);
  }

  return [...byReviewAndType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, actions]) => {
      const [reviewId, eventType] = key.split(':') as [string, ReviewActionEvent['event_type']];
      return detectReviewActionGroup(reviewId, eventType, actions, input.now, windowStart, expected);
    });
}

export function detectAgentTargeting(input: ReviewActionSwarmInput): AgentTargetingDetection[] {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const windowStart = input.now - windowMs;
  const byTarget = new Map<string, ReviewActionEvent[]>();

  for (const action of input.actions) {
    if (!action.signed) continue;
    if (action.created_at < windowStart || action.created_at > input.now) continue;
    if (action.event_type === 'review.vote' && action.vote !== -1) continue;
    if (!action.target_agent_id || !action.venue_id) continue;
    const actions = byTarget.get(action.target_agent_id) ?? [];
    actions.push(action);
    byTarget.set(action.target_agent_id, actions);
  }

  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([targetAgentId, actions]) => detectAgentTargetGroup(targetAgentId, actions, input.now, windowStart));
}

function detectVenue(
  venueId: string,
  reviews: VenueCampaignReview[],
  now: number,
  windowStart: number,
  expected: number,
): VenueCampaignDetection[] {
  const count = reviews.length;
  if (count < 5) return [];

  const velocityScore = (count - expected) / Math.sqrt(expected + 1);
  if (velocityScore < 4) return [];

  const newCount = reviews.filter((review) => now - review.agent_created_at <= NEW_AGENT_AGE_MS).length;
  const lowTrustCount = reviews.filter((review) => finiteTrust(review.author_trust) < LOW_TRUST_THRESHOLD).length;
  const avgRating = reviews.reduce((sum, review) => sum + clampRating(review.rating), 0) / count;
  const fracNew = newCount / count;
  const fracLowTrust = lowTrustCount / count;
  const convergenceScore = velocityScore * (1 + fracNew + fracLowTrust);
  const direction = avgRating <= 1.5
    ? 'venue.review_bomb'
    : avgRating >= 4.5
      ? 'venue.astroturf'
      : null;

  if (!direction) return [];
  if (convergenceScore < 4 || fracLowTrust < 0.5) return [];

  const severity: DetectionSeverity = convergenceScore >= 6 && count >= 8 ? 'critical' : 'warn';
  const score = round(convergenceScore);
  return [{
    type: direction,
    severity,
    venue_id: venueId,
    score,
    window_start: windowStart,
    window_end: now,
    suspect_review_ids: reviews.map((review) => review.id).sort(),
    shadow_multiplier: round(Math.max(0.1, 1 - Math.min(0.9, score / 10))),
    evidence: {
      review_count: count,
      avg_rating: round(avgRating),
      frac_new: round(fracNew),
      frac_low_trust: round(fracLowTrust),
      velocity_score: round(velocityScore),
      convergence_score: score,
    },
  }];
}

function detectReviewActionGroup(
  reviewId: string,
  eventType: ReviewActionEvent['event_type'],
  actions: ReviewActionEvent[],
  now: number,
  windowStart: number,
  expected: number,
): ReviewActionSwarmDetection[] {
  const count = actions.length;
  if (count < 5) return [];

  const velocityScore = (count - expected) / Math.sqrt(expected + 1);
  if (velocityScore < 4) return [];

  const newCount = actions.filter((action) => now - action.agent_created_at <= NEW_AGENT_AGE_MS).length;
  const lowTrustCount = actions.filter((action) => finiteTrust(action.actor_trust) < LOW_TRUST_THRESHOLD).length;
  const connFpCounts = countBy(actions.map((action) => action.conn_fp).filter((connFp): connFp is string => Boolean(connFp)));
  const maxConnFpCount = Math.max(0, ...connFpCounts.values());
  const distinctConnFpCount = connFpCounts.size;
  const fracNew = newCount / count;
  const fracLowTrust = lowTrustCount / count;
  const fracSharedConnFp = maxConnFpCount / count;
  const coordinationScore = velocityScore * (1 + fracNew + fracLowTrust + fracSharedConnFp);

  if (coordinationScore < 4) return [];
  if (fracLowTrust < 0.5 && fracNew < 0.5 && fracSharedConnFp < 0.5) return [];

  const score = round(coordinationScore);
  return [{
    type: eventType === 'review.flag' ? 'review.flag_swarm' : 'review.vote_swarm',
    severity: score >= 6 && count >= 8 ? 'critical' : 'warn',
    review_id: reviewId,
    score,
    window_start: windowStart,
    window_end: now,
    suspect_action_ids: actions.map((action) => action.id).sort(),
    evidence: {
      action_count: count,
      frac_new: round(fracNew),
      frac_low_trust: round(fracLowTrust),
      distinct_conn_fp_count: distinctConnFpCount,
      max_conn_fp_count: maxConnFpCount,
      velocity_score: round(velocityScore),
      coordination_score: score,
    },
  }];
}

function detectAgentTargetGroup(
  targetAgentId: string,
  actions: ReviewActionEvent[],
  now: number,
  windowStart: number,
): AgentTargetingDetection[] {
  const attackerCount = new Set(actions.map((action) => action.agent_id)).size;
  const reviewIds = [...new Set(actions.map((action) => action.review_id))].sort();
  const venueIds = [...new Set(actions.map((action) => action.venue_id).filter((venueId): venueId is string => Boolean(venueId)))].sort();
  if (attackerCount < 8 || venueIds.length < 3) return [];

  const newCount = actions.filter((action) => now - action.agent_created_at <= NEW_AGENT_AGE_MS).length;
  const lowTrustCount = actions.filter((action) => finiteTrust(action.actor_trust) < LOW_TRUST_THRESHOLD).length;
  const connFpCounts = countBy(actions.map((action) => action.conn_fp).filter((connFp): connFp is string => Boolean(connFp)));
  const maxConnFpCount = Math.max(0, ...connFpCounts.values());
  const fracNew = newCount / actions.length;
  const fracLowTrust = lowTrustCount / actions.length;
  if (fracLowTrust < 0.5) return [];

  const targetingScore = round((attackerCount / 2) * (1 + fracNew + fracLowTrust + venueIds.length / 10));
  if (targetingScore < 4) return [];

  return [{
    type: 'agent.targeted',
    severity: targetingScore >= 6 ? 'critical' : 'warn',
    target_agent_id: targetAgentId,
    score: targetingScore,
    window_start: windowStart,
    window_end: now,
    suspect_action_ids: actions.map((action) => action.id).sort(),
    suspect_review_ids: reviewIds,
    venue_ids: venueIds,
    evidence: {
      action_count: actions.length,
      attacker_count: attackerCount,
      affected_review_count: reviewIds.length,
      affected_venue_count: venueIds.length,
      frac_new: round(fracNew),
      frac_low_trust: round(fracLowTrust),
      max_conn_fp_count: maxConnFpCount,
      targeting_score: targetingScore,
    },
  }];
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function finiteTrust(value: number | null): number {
  return Number.isFinite(value) ? Math.max(0, value as number) : 0;
}

function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
