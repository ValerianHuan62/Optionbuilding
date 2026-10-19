export type SmileIvPoint = { moneynessPct: number; iv: number };

export function interpolateSmileIv(
  points: SmileIvPoint[],
  targetPct: number,
  maxBracketWidthPct = 3,
): number | null {
  if (!Number.isFinite(targetPct)) return null;
  const valid = points
    .filter(x => Number.isFinite(x.moneynessPct) && Number.isFinite(x.iv) && x.iv > 0)
    .sort((a, b) => a.moneynessPct - b.moneynessPct);
  const exact = valid.find(x => Math.abs(x.moneynessPct - targetPct) < 1e-9);
  if (exact) return exact.iv;
  const lower = [...valid].reverse().find(x => x.moneynessPct < targetPct);
  const upper = valid.find(x => x.moneynessPct > targetPct);
  if (!lower || !upper || upper.moneynessPct - lower.moneynessPct > maxBracketWidthPct) return null;
  const weight = (targetPct - lower.moneynessPct) / (upper.moneynessPct - lower.moneynessPct);
  return lower.iv + weight * (upper.iv - lower.iv);
}

export function smileButterfly3Pct(points: SmileIvPoint[]): number | null {
  const left = interpolateSmileIv(points, -3);
  const right = interpolateSmileIv(points, 3);
  const atm = interpolateSmileIv(points, 0);
  return left == null || right == null || atm == null ? null : ((left + right) / 2 - atm) * 100;
}

export function smileSkew3Pct(points: SmileIvPoint[]): number | null {
  const left = interpolateSmileIv(points, -3);
  const right = interpolateSmileIv(points, 3);
  return left == null || right == null ? null : (left - right) * 100;
}
