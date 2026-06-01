import { describe, expect, it } from 'vitest';
import { computeTrustScores, effectiveVouchBudget, vouchBudget } from './trust-graph';

describe('trust graph', () => {
  it('assigns zero trust when no trust roots are configured', () => {
    const scores = computeTrustScores({
      agents: ['root', 'alice', 'bob'],
      roots: [],
      edges: [
        { from: 'root', to: 'alice' },
        { from: 'alice', to: 'bob' },
      ],
    });

    expect(scores).toEqual({
      root: 0,
      alice: 0,
      bob: 0,
    });
  });

  it('propagates deterministic trust from configurable roots', () => {
    const first = computeTrustScores({
      agents: ['root', 'alice', 'bob', 'carol'],
      roots: ['root'],
      edges: [
        { from: 'root', to: 'alice' },
        { from: 'alice', to: 'bob' },
        { from: 'root', to: 'carol' },
      ],
      iterations: 50,
    });
    const second = computeTrustScores({
      agents: ['carol', 'bob', 'alice', 'root'],
      roots: ['root'],
      edges: [
        { from: 'root', to: 'carol' },
        { from: 'alice', to: 'bob' },
        { from: 'root', to: 'alice' },
      ],
      iterations: 50,
    });

    expect(first.root).toBeGreaterThan(first.alice);
    expect(first.alice).toBeGreaterThan(first.bob);
    expect(first.carol).toBeCloseTo(first.alice, 10);
    expect(second).toEqual(first);
  });

  it('keeps an isolated Sybil cluster near zero even when internally vouched', () => {
    const scores = computeTrustScores({
      agents: ['root', 'trusted', 'sybil-a', 'sybil-b', 'sybil-c'],
      roots: ['root'],
      edges: [
        { from: 'root', to: 'trusted' },
        { from: 'sybil-a', to: 'sybil-b' },
        { from: 'sybil-b', to: 'sybil-c' },
        { from: 'sybil-c', to: 'sybil-a' },
      ],
      iterations: 50,
    });

    expect(scores.trusted).toBeGreaterThan(0);
    expect(scores['sybil-a']).toBeCloseTo(0, 12);
    expect(scores['sybil-b']).toBeCloseTo(0, 12);
    expect(scores['sybil-c']).toBeCloseTo(0, 12);
  });

  it('gives fresh agents no vouch budget until they earn trust', () => {
    expect(vouchBudget(0)).toBe(0);
    expect(vouchBudget(1)).toBe(1);
    expect(vouchBudget(3)).toBe(2);
    expect(vouchBudget(7)).toBe(3);
  });

  it('adds only explicit platform attestation bonus to vouch budget', () => {
    expect(effectiveVouchBudget(0, 0)).toBe(0);
    expect(effectiveVouchBudget(0, 1)).toBe(1);
    expect(effectiveVouchBudget(3, 1)).toBe(3);
  });
});
