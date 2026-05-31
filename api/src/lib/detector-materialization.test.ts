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

  it('plans review-scoped vote and flag swarm alerts from signed action log entries once', () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, index) => ({
        seq: index + 1,
        event_type: 'review.flag',
        object_id: `flag-${index}`,
        created_at: now - 60_000,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        seq: index + 9,
        event_type: 'review.vote',
        object_id: `vote-${index}`,
        created_at: now - 30_000,
      })),
    ];
    const actionRows = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `flag-${index}`,
        review_id: 'review-target',
        agent_id: `fresh-flag-${index}`,
        event_type: 'review.flag' as const,
        created_at: now - 60_000,
        agent_created_at: now - 60_000,
        actor_trust: 0.01,
        signed: true,
        conn_fp: 'shared-private-fingerprint',
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `vote-${index}`,
        review_id: 'review-target',
        agent_id: `fresh-vote-${index}`,
        event_type: 'review.vote' as const,
        vote: -1,
        created_at: now - 30_000,
        agent_created_at: now - 60_000,
        actor_trust: 0.01,
        signed: true,
        conn_fp: 'shared-private-fingerprint',
      })),
    ];

    const first = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: 0,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews: [],
      reviewActions: actionRows,
    });

    expect(first.next_cursor_seq).toBe(16);
    expect(first.reviewMitigations).toEqual([]);
    expect(first.alerts.map((alert) => alert.type).sort()).toEqual([
      'review.flag_swarm',
      'review.vote_swarm',
    ]);
    expect(first.alerts[0]).toMatchObject({
      subject_type: 'review',
      subject_id: 'review-target',
      severity: 'critical',
      auto_action_taken: 'flag_swarm_gate',
    });
    expect(first.alerts[0].dedup_key).toMatch(/^review\.(flag|vote)_swarm:review-target:/);
    expect(JSON.stringify(first.alerts)).not.toContain('shared-private-fingerprint');

    const replay = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: first.next_cursor_seq,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews: [],
      reviewActions: actionRows,
    });

    expect(replay).toMatchObject({
      next_cursor_seq: 16,
      anomalyScores: [],
      alerts: [],
      reviewMitigations: [],
    });
  });

  it('plans an agent-targeted alert for signed down-action pressure across multiple venues', () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1,
      event_type: index % 2 === 0 ? 'review.flag' : 'review.vote',
      object_id: `target-action-${index}`,
      created_at: now - 60_000,
    }));
    const actionRows = Array.from({ length: 8 }, (_, index) => ({
      id: `target-action-${index}`,
      review_id: `target-review-${index % 4}`,
      target_agent_id: 'agent-under-attack',
      venue_id: `venue-${index % 4}`,
      agent_id: `fresh-attacker-${index}`,
      event_type: index % 2 === 0 ? 'review.flag' as const : 'review.vote' as const,
      vote: index % 2 === 0 ? undefined : -1,
      created_at: now - 60_000,
      agent_created_at: now - 60_000,
      actor_trust: 0.01,
      signed: true,
      conn_fp: 'shared-private-fingerprint',
    }));

    const first = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: 0,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews: [],
      reviewActions: actionRows,
    });

    expect(first.next_cursor_seq).toBe(8);
    expect(first.reviewMitigations).toEqual([]);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]).toMatchObject({
      type: 'agent.targeted',
      subject_type: 'agent',
      subject_id: 'agent-under-attack',
      severity: 'critical',
      auto_action_taken: 'targeted_agent_watch',
    });
    expect(first.alerts[0].dedup_key).toMatch(/^agent\.targeted:agent-under-attack:/);
    expect(first.anomalyScores[0]).toMatchObject({
      type: 'agent.targeted',
      subject_type: 'agent',
      subject_id: 'agent-under-attack',
    });
    expect(first.alerts[0].evidence_json).toContain('target-review-0');
    expect(first.alerts[0].evidence_json).toContain('venue-0');
    expect(JSON.stringify(first.alerts)).not.toContain('shared-private-fingerprint');

    const replay = planDetectorMaterialization({
      detector: 'l4_hot_path',
      cursor_seq: first.next_cursor_seq,
      now,
      windowMs: HOUR,
      logEntries: entries,
      reviews: [],
      reviewActions: actionRows,
    });

    expect(replay).toMatchObject({
      next_cursor_seq: 8,
      anomalyScores: [],
      alerts: [],
      reviewMitigations: [],
    });
  });
});
