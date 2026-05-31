import type { Category } from '../types';

const DEFAULT_PRIOR = 3.5;
const PRIOR_WEIGHT = 8;
const DEFAULT_HALF_LIFE_DAYS = 365;
const CATEGORY_HALF_LIFE_DAYS: Partial<Record<Category, number>> = {
  restaurant: 180,
  coffee: 270,
  bathroom: 540,
  bar: 180,
  airport_lounge: 270,
  hotel: 365,
  gym: 365,
};

export interface ReviewScoreInput {
  id: string;
  venue_id: string;
  agent_id: string;
  category: Category | string;
  rating: number;
  review_created_at: number;
  agent_created_at: number;
  author_trust: number;
  upvote_weight?: number;
  downvote_weight?: number;
  mitigation_multiplier?: number | null;
  cluster_id?: string | null;
}

export interface VenueScoreInput {
  now: number;
  reviews: ReviewScoreInput[];
  categoryPriors?: Partial<Record<Category | string, number>>;
}

export interface ReviewWeight {
  review_id: string;
  venue_id: string;
  base_weight: number;
  decayed_weight: number;
  cluster_key: string;
}

export interface VenueScore {
  venue_id: string;
  category: string;
  rep_score: number;
  rep_confidence: number;
  rep_rank: number;
  effective_weight: number;
  prior: number;
  review_weights: ReviewWeight[];
}

export function computeVenueScores(input: VenueScoreInput): VenueScore[] {
  const byVenue = new Map<string, ReviewScoreInput[]>();
  for (const review of input.reviews) {
    if (!Number.isFinite(review.rating)) continue;
    const reviews = byVenue.get(review.venue_id) ?? [];
    reviews.push(review);
    byVenue.set(review.venue_id, reviews);
  }

  return [...byVenue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([venueId, reviews]) => computeVenueScore(venueId, reviews, input));
}

export function reviewBaseWeight(input: {
  now: number;
  review_created_at: number;
  agent_created_at: number;
  author_trust: number;
  upvote_weight?: number;
  downvote_weight?: number;
  mitigation_multiplier?: number | null;
}): number {
  const trust = finiteNonNegative(input.author_trust);
  const ageRamp = accountAgeFactor(input.now, input.agent_created_at);
  const vote = voteFactor(input.upvote_weight ?? 0, input.downvote_weight ?? 0);
  const mitigation = mitigationFactor(input.mitigation_multiplier);
  return roundWeight(trust * ageRamp * vote * mitigation);
}

export function decayFactor(category: Category | string, ageDays: number): number {
  const halfLife = CATEGORY_HALF_LIFE_DAYS[category as Category] ?? DEFAULT_HALF_LIFE_DAYS;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.exp(-Math.log(2) * ageDays / halfLife);
}

function computeVenueScore(
  venueId: string,
  reviews: ReviewScoreInput[],
  input: VenueScoreInput,
): VenueScore {
  const category = reviews[0]?.category ?? 'other';
  const prior = input.categoryPriors?.[category] ?? DEFAULT_PRIOR;
  const scored = reviews.map((review) => {
    const ageDays = Math.max(0, (input.now - review.review_created_at) / 86_400_000);
    const baseWeight = reviewBaseWeight({
      now: input.now,
      review_created_at: review.review_created_at,
      agent_created_at: review.agent_created_at,
      author_trust: review.author_trust,
      upvote_weight: review.upvote_weight,
      downvote_weight: review.downvote_weight,
      mitigation_multiplier: review.mitigation_multiplier,
    });
    const decayedWeight = roundWeight(baseWeight * decayFactor(review.category, ageDays));
    return {
      review,
      weight: {
        review_id: review.id,
        venue_id: review.venue_id,
        base_weight: baseWeight,
        decayed_weight: decayedWeight,
        cluster_key: review.cluster_id || review.agent_id,
      },
    };
  });
  const effective = collapseClusters(scored);
  const totalWeight = effective.reduce((sum, item) => sum + item.weight.decayed_weight, 0);
  const weightedRatings = effective.reduce(
    (sum, item) => sum + item.weight.decayed_weight * clampRating(item.review.rating),
    0,
  );
  const repScore = (PRIOR_WEIGHT * prior + weightedRatings) / (PRIOR_WEIGHT + totalWeight);
  const confidence = totalWeight / (totalWeight + PRIOR_WEIGHT);

  return {
    venue_id: venueId,
    category,
    rep_score: roundScore(repScore),
    rep_confidence: roundScore(confidence),
    rep_rank: roundScore(repScore * (0.5 + 0.5 * confidence)),
    effective_weight: roundWeight(totalWeight),
    prior,
    review_weights: scored.map((item) => item.weight),
  };
}

function collapseClusters<T extends { weight: ReviewWeight; review: ReviewScoreInput }>(items: T[]): T[] {
  const byCluster = new Map<string, T>();
  for (const item of items) {
    const existing = byCluster.get(item.weight.cluster_key);
    if (!existing || item.weight.decayed_weight > existing.weight.decayed_weight) {
      byCluster.set(item.weight.cluster_key, item);
    }
  }
  return [...byCluster.values()];
}

function accountAgeFactor(now: number, agentCreatedAt: number): number {
  const ageDays = Math.max(0, (now - agentCreatedAt) / 86_400_000);
  return Math.min(1, ageDays / 30);
}

function voteFactor(upvoteWeight: number, downvoteWeight: number): number {
  return clamp(1 + 0.1 * finiteNonNegative(upvoteWeight) - 0.1 * finiteNonNegative(downvoteWeight), 0.5, 1.5);
}

function mitigationFactor(value: number | null | undefined): number {
  if (value === null || value === undefined) return 1;
  if (!Number.isFinite(value)) return 1;
  return clamp(value, 0, 1);
}

function clampRating(rating: number): number {
  return clamp(rating, 1, 5);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundWeight(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
