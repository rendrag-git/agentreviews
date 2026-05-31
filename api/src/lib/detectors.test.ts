import { describe, expect, it } from 'vitest';
import { detectReviewActionSwarms, detectVenueReviewCampaigns } from './detectors';

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

describe('review action swarm detectors', () => {
  it('raises review-scoped alerts for coordinated signed flag/downvote bursts without exposing raw fingerprints', () => {
    const coordinated = Array.from({ length: 8 }, (_, index) => ({
      id: `flag-${index}`,
      review_id: 'review-target',
      agent_id: `fresh-${index}`,
      event_type: 'review.flag' as const,
      created_at: now - 60_000,
      agent_created_at: now - 5 * 60_000,
      actor_trust: 0.02,
      signed: true,
      conn_fp: 'shared-private-fingerprint',
    }));

    const detections = detectReviewActionSwarms({
      now,
      windowMs: HOUR,
      actions: [
        ...coordinated,
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `vote-${index}`,
          review_id: 'review-target',
          agent_id: `fresh-vote-${index}`,
          event_type: 'review.vote' as const,
          vote: -1,
          created_at: now - 30_000,
          agent_created_at: now - 5 * 60_000,
          actor_trust: 0.02,
          signed: true,
          conn_fp: 'shared-private-fingerprint',
        })),
      ],
    });

    expect(detections).toHaveLength(2);
    expect(detections.map((detection) => detection.type).sort()).toEqual([
      'review.flag_swarm',
      'review.vote_swarm',
    ]);
    expect(detections[0]).toMatchObject({
      severity: 'critical',
      review_id: 'review-target',
      evidence: {
        action_count: 8,
        max_conn_fp_count: 8,
        distinct_conn_fp_count: 1,
      },
    });
    expect(JSON.stringify(detections)).not.toContain('shared-private-fingerprint');
  });

  it('ignores organic independent signed actions and legacy unsigned actions', () => {
    const detections = detectReviewActionSwarms({
      now,
      windowMs: HOUR,
      actions: [
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `organic-${index}`,
          review_id: 'review-organic',
          agent_id: `known-${index}`,
          event_type: 'review.flag' as const,
          created_at: now - index * 60_000,
          agent_created_at: now - 120 * DAY,
          actor_trust: 0.8,
          signed: true,
          conn_fp: `independent-${index}`,
        })),
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `legacy-${index}`,
          review_id: 'review-legacy',
          agent_id: `legacy-${index}`,
          event_type: 'review.flag' as const,
          created_at: now - 60_000,
          agent_created_at: now,
          actor_trust: 0,
          signed: false,
          conn_fp: 'shared-private-fingerprint',
        })),
      ],
    });

    expect(detections).toEqual([]);
  });
});
