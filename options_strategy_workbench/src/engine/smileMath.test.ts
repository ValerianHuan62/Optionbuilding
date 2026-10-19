import { describe, expect, it } from 'vitest';
import { interpolateSmileIv, smileButterfly3Pct, smileSkew3Pct, type SmileIvPoint } from './smileMath';

const symmetricSmile: SmileIvPoint[] = [
  { moneynessPct: -4, iv: 0.32 },
  { moneynessPct: -2, iv: 0.30 },
  { moneynessPct: -1, iv: 0.295 },
  { moneynessPct: 1, iv: 0.285 },
  { moneynessPct: 2, iv: 0.28 },
  { moneynessPct: 4, iv: 0.30 },
];

describe('smile interpolation and 3% metrics', () => {
  it('interpolates only between nearby observed points', () => {
    expect(interpolateSmileIv(symmetricSmile, -3)).toBeCloseTo(0.31);
    expect(interpolateSmileIv(symmetricSmile, 0)).toBeCloseTo(0.29);
    expect(interpolateSmileIv([{ moneynessPct: -5, iv: 0.3 }, { moneynessPct: 5, iv: 0.4 }], 0)).toBeNull();
    expect(interpolateSmileIv(symmetricSmile, -6)).toBeNull();
  });

  it('computes Butterfly 3% and Skew 3% in volatility points', () => {
    expect(smileButterfly3Pct(symmetricSmile)).toBeCloseTo(1);
    expect(smileSkew3Pct(symmetricSmile)).toBeCloseTo(2);
  });

  it('returns unavailable when any required bracket is missing', () => {
    const incomplete = symmetricSmile.filter(x => x.moneynessPct < 0);
    expect(smileButterfly3Pct(incomplete)).toBeNull();
    expect(smileSkew3Pct(incomplete)).toBeNull();
  });
});
