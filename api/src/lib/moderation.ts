export const FLAG_PRESSURE_HIDE_THRESHOLD = 1.5;

export type ModerationState = 'visible' | 'soft_hidden' | 'quarantined';

export interface FlagModerationProjection {
  flag_pressure: number;
  moderation_state: ModerationState;
}

export function projectFlagModeration(
  flagWeights: number[],
  threshold = FLAG_PRESSURE_HIDE_THRESHOLD,
): FlagModerationProjection {
  const flagPressure = flagWeights
    .filter((weight) => Number.isFinite(weight) && weight > 0)
    .reduce((sum, weight) => sum + weight, 0);

  return {
    flag_pressure: roundPressure(flagPressure),
    moderation_state: flagPressure >= threshold ? 'soft_hidden' : 'visible',
  };
}

function roundPressure(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
