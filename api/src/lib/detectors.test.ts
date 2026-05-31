import { describe, expect, it } from 'vitest';
import { detectVenueReviewCampaigns } from './detectors';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = 1_780_000_000_000;

describe('venue campaign detectors', () => {
  it('raises a critical review-bomb alert for a fresh low-trust 1-star swarm but not organic growth', () => {
    const bomb = detectVenueReviewCampaigns({
      now,
      windowMs: HOUR,
      reviews: Array.from({ length: 50 }, (_, index) => ({
        id: `bomb-${index}`,
        venue_id: 'venue-bomb',
        agent_id: `fresh-${index}`,
        rating: 1,
        review_created_at: now - 10 * 60 * 1000,
        agent_created_at: now - 5 * 60 * 1000,
        author_trust: 0,
      })),
    });

    expect(bomb).toHaveLength(1);
    expect(bomb[0]).toMatchObject({
      type: 'venue.review_bomb',
      severity: 'critical',
      venue_id: 'venue-bomb',
      suspect_review_ids: expect.arrayContaining(['bomb-0', 'bomb-49']),
    });
    expect(bomb[0].shadow_multiplier).toBeLessThanOrEqual(0.1);

    const organic = detectVenueReviewCampaigns({
      now,
      windowMs: HOUR,
      reviews: Array.from({ length: 50 }, (_, index) => ({
        id: `organic-${index}`,
        venue_id: 'venue-organic',
        agent_id: `known-${index}`,
        rating: 4,
        review_created_at: now - (index + 1) * DAY,
        agent_created_at: now - 120 * DAY,
        author_trust: 0.8,
      })),
    });

    expect(organic).toEqual([]);
  });

  it('raises an astroturf alert for a fresh low-trust 5-star swarm', () => {
    const detections = detectVenueReviewCampaigns({
      now,
      windowMs: HOUR,
      reviews: Array.from({ length: 12 }, (_, index) => ({
        id: `boost-${index}`,
        venue_id: 'venue-boost',
        agent_id: `fresh-boost-${index}`,
        rating: 5,
        review_created_at: now - 2 * 60 * 1000,
        agent_created_at: now - 15 * 60 * 1000,
        author_trust: 0.01,
      })),
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      type: 'venue.astroturf',
      severity: 'critical',
      venue_id: 'venue-boost',
    });
  });
});
