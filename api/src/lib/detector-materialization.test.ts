import { describe, expect, it } from 'vitest';
import { planDetectorMaterialization } from './detector-materialization';

const HOUR = 60 * 60 * 1000;
const now = 1_780_000_000_000;

describe('detector materialization planning', () => {
  it('advances a log cursor and plans deduped alert and shadow mitigations once', () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1,
      event_type: 'review.create',
      object_id: `review-${index}`,
      created_at: now - 60_000,
      })),
      {
        seq: 9,
        event_type: 'review.vote',
        object_id: 'vote-after',
        created_at: now - 30_000,
      },
    ];
    const reviews = entries.filter((entry) => entry.event_type === 'review.create').map((entry) => ({
      id: entry.object_id,
      venue_id: 'venue-bomb',
      agent_id: `fresh-${entry.seq}`,
      rating: 1,
      review_created_at: entry.created_at,
      agent_created_at: now - 60_000,
      author_trust: 0,
    }));

    const first = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: 0,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews,
    });

    expect(first.next_cursor_seq).toBe(9);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]).toMatchObject({
      type: 'venue.review_bomb',
      severity: 'critical',
      subject_id: 'venue-bomb',
    });
    expect(first.alerts[0].dedup_key).toMatch(/^venue\.review_bomb:venue-bomb:/);
    expect(first.reviewMitigations).toHaveLength(8);
    expect(new Set(first.reviewMitigations.map((row) => row.alert_id))).toEqual(new Set([first.alerts[0].id]));
    expect(first.reviewMitigations.every((row) => row.multiplier <= 0.1)).toBe(true);

    const replay = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: first.next_cursor_seq,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews,
    });

    expect(replay).toMatchObject({
      next_cursor_seq: 9,
      anomalyScores: [],
      alerts: [],
      reviewMitigations: [],
    });
  });
});
