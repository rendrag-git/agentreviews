import { describe, expect, it } from 'vitest';
import { projectFlagModeration } from './moderation';

describe('trust-weighted flag moderation', () => {
  it('soft-hides only when signed flag pressure reaches the trust threshold', () => {
    expect(projectFlagModeration([0, 0, 0])).toEqual({
      flag_pressure: 0,
      moderation_state: 'visible',
    });
    expect(projectFlagModeration([0.8, 0.6])).toEqual({
      flag_pressure: 1.4,
      moderation_state: 'visible',
    });
    expect(projectFlagModeration([0.8, 0.7])).toEqual({
      flag_pressure: 1.5,
      moderation_state: 'soft_hidden',
    });
  });

  it('suppresses soft-hide when the flag swarm detector has fired', () => {
    expect(projectFlagModeration([0.8, 0.7], undefined, { flagSwarmActive: true })).toEqual({
      flag_pressure: 1.5,
      moderation_state: 'visible',
    });
  });
});
