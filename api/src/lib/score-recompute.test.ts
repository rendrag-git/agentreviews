import { describe, expect, it } from 'vitest';
import { planVenueScoreMaterialization } from './score-recompute';

const DAY = 24 * 60 * 60 * 1000;

describe('venue score materialization planning', () => {
  it('materializes venue score updates and per-review weights from DB-shaped rows', () => {
    const epoch = 1_780_000_000_000;
    const updates = planVenueScoreMaterialization({
      epoch,
      reviews: [
        {
          id: 'low-trust-5',
          venue_id: 'venue-a',
          agent_id: 'low',
          category: 'restaurant',
          rating: 5,
          review_created_at: epoch,
          agent_created_at: epoch,
          author_trust: 0,
          upvote_weight: 10,
          downvote_weight: 0,
        },
        {
          id: 'trusted-2',
          venue_id: 'venue-a',
          agent_id: 'trusted',
          category: 'restaurant',
          rating: 2,
          review_created_at: epoch,
          agent_created_at: epoch - 60 * DAY,
          author_trust: 0.8,
          upvote_weight: 0,
          downvote_weight: 0,
        },
      ],
    });

    expect(updates.venueUpdates).toEqual([
      expect.objectContaining({
        venue_id: 'venue-a',
        rep_epoch: epoch,
      }),
    ]);
    expect(updates.venueUpdates[0].rep_score).toBeLessThan(3.5);
    expect(updates.venueUpdates[0].rep_confidence).toBeGreaterThan(0);
    expect(updates.reviewWeights.find((row) => row.review_id === 'low-trust-5')).toMatchObject({
      base_weight: 0,
      decayed_weight: 0,
    });
    expect(updates.reviewWeights.find((row) => row.review_id === 'trusted-2')?.base_weight).toBeGreaterThan(0);
  });
});
