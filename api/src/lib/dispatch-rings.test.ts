import { describe, expect, it } from 'vitest';
import {
  detectDispatchRings,
  estimateJaccard,
  minhashSignature,
  trueShingleJaccard,
} from './dispatch-rings';

const now = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('MinHash review similarity', () => {
  it('approximates true shingle Jaccard while separating distinct review bodies', () => {
    const left = 'Bathroom was spotless, stocked, quiet, and easy to find near the back hallway.';
    const near = 'Bathroom was spotless, stocked, quiet, and easy to find near the back hallway.';
    const far = 'Espresso was bitter, the bar was crowded, and the music was too loud.';

    const trueNear = trueShingleJaccard(left, near);
    const estimatedNear = estimateJaccard(minhashSignature(left), minhashSignature(near));
    const estimatedFar = estimateJaccard(minhashSignature(left), minhashSignature(far));

    expect(trueNear).toBeGreaterThan(0.6);
    expect(Math.abs(estimatedNear - trueNear)).toBeLessThan(0.2);
    expect(estimatedNear).toBeGreaterThan(0.6);
    expect(estimatedFar).toBeLessThan(0.25);
  });
});

describe('dispatch ring detection', () => {
  it('requires corroborating coordination signals beyond shared lineage and content', () => {
    const sharedLineageAndContent = Array.from({ length: 6 }, (_, index) => review({
      id: `lineage-content-${index}`,
      agent_id: `agent-${index}`,
      body: `Spotless stocked bathroom with clear signage and a dry floor ${index % 2}`,
      vouch_ancestor_id: 'root-a',
      created_at: now - index * 5 * 60_000,
      agent_created_at: now - 90 * DAY,
      conn_fp: `independent-${index}`,
      conn_fp_prevalence: 1,
    }));

    expect(detectDispatchRings({ now, reviews: sharedLineageAndContent })).toEqual([]);

    const coordinated = sharedLineageAndContent.map((item, index) => ({
      ...item,
      id: `coordinated-${index}`,
      agent_id: `coordinated-${index}`,
      created_at: now - index * 15_000,
      agent_created_at: now - 30 * 60_000,
      conn_fp: 'shared-private-fingerprint',
      conn_fp_prevalence: 0.05,
    }));

    const detections = detectDispatchRings({ now, reviews: coordinated });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      type: 'dispatch.suspected',
      severity: 'critical',
      venue_id: 'venue-a',
    });
    expect(detections[0].member_agent_ids).toEqual([
      'coordinated-0',
      'coordinated-1',
      'coordinated-2',
      'coordinated-3',
      'coordinated-4',
      'coordinated-5',
    ]);
    expect(detections[0].score).toBeGreaterThanOrEqual(0.8);
    expect(detections[0].evidence.feature_count).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(detections)).not.toContain('shared-private-fingerprint');
  });
});

function review(overrides: Partial<Parameters<typeof detectDispatchRings>[0]['reviews'][number]> = {}) {
  return {
    id: 'review',
    venue_id: 'venue-a',
    agent_id: 'agent',
    body: 'Spotless stocked bathroom with clear signage and a dry floor.',
    tags: ['bathroom'],
    rating: 5,
    created_at: now,
    agent_created_at: now - DAY,
    vouch_ancestor_id: null,
    conn_fp: null,
    conn_fp_prevalence: 1,
    ...overrides,
  };
}
