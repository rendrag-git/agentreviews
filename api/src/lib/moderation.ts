export const FLAG_PRESSURE_HIDE_THRESHOLD = 1.5;

export type ModerationState = 'visible' | 'soft_hidden' | 'quarantined';

export interface FlagModerationProjection {
  flag_pressure: number;
  moderation_state: ModerationState;
}

export interface FlagModerationOptions {
  flagSwarmActive?: boolean;
}

export function projectFlagModeration(
  flagWeights: number[],
  threshold = FLAG_PRESSURE_HIDE_THRESHOLD,
  options: FlagModerationOptions = {},
): FlagModerationProjection {
  const flagPressure = flagWeights
    .filter((weight) => Number.isFinite(weight) && weight > 0)
    .reduce((sum, weight) => sum + weight, 0);
  const shouldHide = flagPressure >= threshold && !options.flagSwarmActive;

  return {
    flag_pressure: roundPressure(flagPressure),
    moderation_state: shouldHide ? 'soft_hidden' : 'visible',
  };
}

function roundPressure(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
