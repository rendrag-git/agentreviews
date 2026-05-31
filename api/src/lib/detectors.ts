export type DetectionType = 'venue.review_bomb' | 'venue.astroturf';
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

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_EXPECTED_REVIEWS = 1;
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
