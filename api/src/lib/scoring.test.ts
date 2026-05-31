import { describe, expect, it } from 'vitest';
import {
  computeVenueScores,
  decayFactor,
  reviewBaseWeight,
} from './scoring';

const DAY = 24 * 60 * 60 * 1000;
const now = 1_780_000_000_000;

describe('trust-weighted venue scoring', () => {
  it('bounds the REN-789 fresh colluding swarm worked example', () => {
    const reviews = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `sybil-${index}`,
        venue_id: 'venue',
        agent_id: `sybil-${index}`,
        category: 'restaurant',
        rating: 5,
        review_created_at: now,
        agent_created_at: now,
        author_trust: 0.001,
        cluster_id: 'fresh-sybil-cluster',
      })),
      {
        id: 'trusted-a',
        venue_id: 'venue',
        agent_id: 'trusted-a',
        category: 'restaurant',
        rating: 2,
        review_created_at: now,
        agent_created_at: now - 90 * DAY,
        author_trust: 0.8,
        cluster_id: 'trusted-a',
      },
      {
        id: 'trusted-b',
        venue_id: 'venue',
        agent_id: 'trusted-b',
        category: 'restaurant',
        rating: 2,
        review_created_at: now,
        agent_created_at: now - 90 * DAY,
        author_trust: 0.7,
        cluster_id: 'trusted-b',
      },
    ];

    const [score] = computeVenueScores({ now, reviews });

    expect(score.venue_id).toBe('venue');
    expect(score.rep_score).toBeGreaterThanOrEqual(3.2);
    expect(score.rep_score).toBeLessThanOrEqual(3.3);
    expect(score.rep_score).toBeLessThan(4);
    expect(score.rep_score).toBeLessThan(4.88);
  });

  it('shrinks a lone trusted 5-star review toward the category prior', () => {
    const [score] = computeVenueScores({
      now,
      reviews: [{
        id: 'one-review',
        venue_id: 'venue',
        agent_id: 'trusted',
        category: 'restaurant',
        rating: 5,
        review_created_at: now,
        agent_created_at: now - 90 * DAY,
        author_trust: 1,
      }],
    });

    expect(score.rep_score).toBeGreaterThan(3.5);
    expect(score.rep_score).toBeLessThan(4);
    expect(score.rep_confidence).toBeLessThan(0.2);
  });

  it('decays restaurants faster than bathrooms', () => {
    const ageDays = 180;

    expect(decayFactor('restaurant', ageDays)).toBeCloseTo(0.5, 5);
    expect(decayFactor('bathroom', ageDays)).toBeGreaterThan(decayFactor('restaurant', ageDays));
  });

  it('collapses a cluster to one effective contributor', () => {
    const withCluster = computeVenueScores({
      now,
      reviews: [
        {
          id: 'a',
          venue_id: 'venue',
          agent_id: 'a',
          category: 'restaurant',
          rating: 5,
          review_created_at: now,
          agent_created_at: now - 90 * DAY,
          author_trust: 1,
          cluster_id: 'ring',
        },
        {
          id: 'b',
          venue_id: 'venue',
          agent_id: 'b',
          category: 'restaurant',
          rating: 5,
          review_created_at: now,
          agent_created_at: now - 90 * DAY,
          author_trust: 1,
          cluster_id: 'ring',
        },
      ],
    })[0];
    const withoutCluster = computeVenueScores({
      now,
      reviews: [
        {
          id: 'a',
          venue_id: 'venue',
          agent_id: 'a',
          category: 'restaurant',
          rating: 5,
          review_created_at: now,
          agent_created_at: now - 90 * DAY,
          author_trust: 1,
        },
        {
          id: 'b',
          venue_id: 'venue',
          agent_id: 'b',
          category: 'restaurant',
          rating: 5,
          review_created_at: now,
          agent_created_at: now - 90 * DAY,
          author_trust: 1,
        },
      ],
    })[0];

    expect(withCluster.rep_confidence).toBeLessThan(withoutCluster.rep_confidence);
    expect(withCluster.effective_weight).toBeCloseTo(1, 8);
    expect(withoutCluster.effective_weight).toBeCloseTo(2, 8);
  });

  it('uses signed trust-weighted votes without letting zero-trust votes move weight', () => {
    const base = reviewBaseWeight({
      now,
      review_created_at: now,
      agent_created_at: now - 90 * DAY,
      author_trust: 0.8,
      upvote_weight: 0,
      downvote_weight: 0,
    });
    const trustedUpvote = reviewBaseWeight({
      now,
      review_created_at: now,
      agent_created_at: now - 90 * DAY,
      author_trust: 0.8,
      upvote_weight: 1,
      downvote_weight: 0,
    });
    const zeroUpvote = reviewBaseWeight({
      now,
      review_created_at: now,
      agent_created_at: now - 90 * DAY,
      author_trust: 0.8,
      upvote_weight: 0,
      downvote_weight: 0,
    });

    expect(trustedUpvote).toBeGreaterThan(base);
    expect(zeroUpvote).toBe(base);
  });
});
