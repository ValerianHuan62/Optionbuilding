import type { GreekInput, GreekInputFormat, GreekRawProfile, GreekValues } from '../models/option';

export const DEFAULT_GREEK_RAW_PROFILE: GreekRawProfile = {
  thetaUnit: 'YEAR', vegaUnit: 'IV_DECIMAL', rhoUnit: 'RATE_DECIMAL', includesMultiplier: false,
};

/** Converts one contract's input to the requested per-contract raw Greek units. */
export function normalizeGreeks(
  raw: GreekInput,
  multiplier: number,
  format: GreekInputFormat = 'STANDARDIZED',
  profile: GreekRawProfile = DEFAULT_GREEK_RAW_PROFILE,
): GreekValues {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return missing();
  const scale = format === 'STANDARDIZED' || (format === 'TONGHUASHUN_RAW' && profile.includesMultiplier) ? 1 / multiplier : 1;
  const convert = (key: keyof GreekValues): number | null => {
    const x = raw[key];
    if (x === undefined || !Number.isFinite(x)) return null;
    if (format === 'KUAIQI_RAW') return x;
    const unit = key === 'theta' ? (format !== 'STANDARDIZED' && profile.thetaUnit === 'YEAR' ? 1 / 365 : 1)
      : key === 'vega' ? (format !== 'STANDARDIZED' && profile.vegaUnit === 'IV_DECIMAL' ? 0.01 : 1)
      : key === 'rho' ? (format !== 'STANDARDIZED' && profile.rhoUnit === 'RATE_DECIMAL' ? 0.01 : 1) : 1;
    return x * scale * unit;
  };
  return { delta: convert('delta'), gamma: convert('gamma'), theta: convert('theta'), vega: convert('vega'), rho: convert('rho') };
}

function missing(): GreekValues { return { delta: null, gamma: null, theta: null, vega: null, rho: null }; }

/** Converts legacy chain values (index-point Greeks, vega/rho per decimal unit) to CNY. */
export function migrateLegacyGreeks(raw: GreekInput, multiplier: number): GreekInput {
  return {
    delta: raw.delta === undefined ? undefined : raw.delta * multiplier,
    gamma: raw.gamma === undefined ? undefined : raw.gamma * multiplier,
    theta: raw.theta === undefined ? undefined : raw.theta * multiplier,
    vega: raw.vega === undefined ? undefined : raw.vega * multiplier / 100,
    rho: raw.rho === undefined ? undefined : raw.rho * multiplier / 100,
    source: 'STANDARDIZED', snapshotAt: raw.snapshotAt,
  };
}

