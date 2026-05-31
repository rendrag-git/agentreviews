import { computeVenueScores, type ReviewScoreInput } from './scoring';

export interface ScoreReviewRow {
  id: string;
  venue_id: string;
  agent_id: string;
  category: string;
  rating: number;
  review_created_at: number;
  agent_created_at: number;
  author_trust: number | null;
  upvote_weight?: number | null;
  downvote_weight?: number | null;
  cluster_id?: string | null;
}

export interface VenueScoreMaterializationInput {
  epoch: number;
  reviews: ScoreReviewRow[];
  categoryPriors?: Record<string, number>;
}

export interface VenueScoreUpdate {
  venue_id: string;
  rep_score: number;
  rep_confidence: number;
  rep_rank: number;
  rep_epoch: number;
}

export interface ReviewWeightUpdate {
  review_id: string;
  venue_id: string;
  base_weight: number;
  decayed_weight: number;
  cluster_key: string;
  score_epoch: number;
}

export interface VenueScoreMaterializationPlan {
  venueUpdates: VenueScoreUpdate[];
  reviewWeights: ReviewWeightUpdate[];
}

export function planVenueScoreMaterialization(input: VenueScoreMaterializationInput): VenueScoreMaterializationPlan {
  const reviews: ReviewScoreInput[] = input.reviews.map((review) => ({
    id: review.id,
    venue_id: review.venue_id,
    agent_id: review.agent_id,
    category: review.category,
    rating: review.rating,
    review_created_at: review.review_created_at,
    agent_created_at: review.agent_created_at,
    author_trust: review.author_trust ?? 0,
    upvote_weight: review.upvote_weight ?? 0,
    downvote_weight: review.downvote_weight ?? 0,
    cluster_id: review.cluster_id,
  }));
  const scores = computeVenueScores({
    now: input.epoch,
    reviews,
    categoryPriors: input.categoryPriors,
  });

  return {
    venueUpdates: scores.map((score) => ({
      venue_id: score.venue_id,
      rep_score: score.rep_score,
      rep_confidence: score.rep_confidence,
      rep_rank: score.rep_rank,
      rep_epoch: input.epoch,
    })),
    reviewWeights: scores.flatMap((score) => score.review_weights.map((weight) => ({
      ...weight,
      score_epoch: input.epoch,
    }))),
  };
}
