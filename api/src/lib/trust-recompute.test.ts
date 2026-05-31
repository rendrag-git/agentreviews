import { describe, expect, it } from 'vitest';
import { planTrustMaterialization } from './trust-recompute';

describe('trust recompute materialization', () => {
  it('treats empty roots as a valid zero-trust state', () => {
    const updates = planTrustMaterialization({
      epoch: 123,
      agents: [
        { id: 'root', earned_trust: 7 },
        { id: 'alice', earned_trust: 3 },
      ],
      roots: [],
      vouches: [{ voucher_id: 'root', vouchee_id: 'alice', weight: 1 }],
    });

    expect(updates).toEqual([
      { id: 'alice', trust_score: 0, vouch_trust: 0, earned_trust: 0, trust_epoch: 123 },
      { id: 'root', trust_score: 0, vouch_trust: 0, earned_trust: 0, trust_epoch: 123 },
    ]);
  });

  it('materializes deterministic scores from active roots and vouches', () => {
    const updates = planTrustMaterialization({
      epoch: 456,
      agents: [
        { id: 'root', earned_trust: 3 },
        { id: 'alice', earned_trust: 0 },
        { id: 'sybil-a', earned_trust: 0 },
        { id: 'sybil-b', earned_trust: 0 },
      ],
      roots: [{ agent_id: 'root', weight: 1 }],
      vouches: [
        { voucher_id: 'root', vouchee_id: 'alice', weight: 1 },
        { voucher_id: 'sybil-a', vouchee_id: 'sybil-b', weight: 1 },
        { voucher_id: 'sybil-b', vouchee_id: 'sybil-a', weight: 1 },
      ],
    });

    expect(updates.map((update) => update.id)).toEqual(['alice', 'root', 'sybil-a', 'sybil-b']);
    expect(updates.find((update) => update.id === 'root')).toMatchObject({
      trust_score: 1,
      earned_trust: 3,
      trust_epoch: 456,
    });
    expect(updates.find((update) => update.id === 'alice')?.trust_score).toBeGreaterThan(0);
    expect(updates.find((update) => update.id === 'alice')?.vouch_trust).toBeGreaterThan(0);
    expect(updates.find((update) => update.id === 'sybil-a')?.trust_score).toBe(0);
    expect(updates.find((update) => update.id === 'sybil-b')?.trust_score).toBe(0);
  });

  it('keeps omitted revoked edges from contributing', () => {
    const activeOnly = planTrustMaterialization({
      epoch: 789,
      agents: [
        { id: 'root', earned_trust: 1 },
        { id: 'alice', earned_trust: 0 },
        { id: 'carol', earned_trust: 2 },
      ],
      roots: [{ agent_id: 'root', weight: 1 }],
      vouches: [{ voucher_id: 'root', vouchee_id: 'alice', weight: 1 }],
    });

    expect(activeOnly.find((update) => update.id === 'alice')?.trust_score).toBeGreaterThan(0);
    expect(activeOnly.find((update) => update.id === 'carol')?.trust_score).toBe(0);
    expect(activeOnly.find((update) => update.id === 'carol')?.earned_trust).toBe(0);
  });

  it('applies only active platform attestation multipliers during materialization', () => {
    const updates = planTrustMaterialization({
      epoch: 999,
      agents: [
        { id: 'root', earned_trust: 1 },
        { id: 'attested', earned_trust: 0, platform_trust_multiplier: 1.2 },
        { id: 'revoked-attestation', earned_trust: 0, platform_trust_multiplier: null },
        { id: 'plain', earned_trust: 0 },
      ],
      roots: [{ agent_id: 'root', weight: 1 }],
      vouches: [
        { voucher_id: 'root', vouchee_id: 'attested', weight: 0.4 },
        { voucher_id: 'root', vouchee_id: 'revoked-attestation', weight: 0.4 },
        { voucher_id: 'root', vouchee_id: 'plain', weight: 0.4 },
      ],
    });

    const attested = updates.find((update) => update.id === 'attested');
    const revoked = updates.find((update) => update.id === 'revoked-attestation');
    const plain = updates.find((update) => update.id === 'plain');

    expect(attested?.trust_score).toBeGreaterThan(plain?.trust_score ?? 0);
    expect(revoked?.trust_score).toBe(plain?.trust_score);
  });
});
