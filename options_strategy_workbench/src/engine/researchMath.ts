export type ExpiryIvPoint = { dte: number; atmIv: number | null };

export function fixedMaturityIv(points: ExpiryIvPoint[], targetDays: number): number | null {
  const valid = points.filter(x => x.atmIv != null && Number.isFinite(x.atmIv) && x.atmIv > 0 && x.dte > 0).sort((a, b) => a.dte - b.dte);
  const exact = valid.find(x => x.dte === targetDays);
  if (exact) return exact.atmIv;
  const left = [...valid].reverse().find(x => x.dte < targetDays);
  const right = valid.find(x => x.dte > targetDays);
  if (!left || !right) return null;
  const targetT = targetDays / 365, leftT = left.dte / 365, rightT = right.dte / 365;
  const leftVariance = left.atmIv! ** 2 * leftT, rightVariance = right.atmIv! ** 2 * rightT;
  const variance = (rightT - targetT) / (rightT - leftT) * leftVariance + (targetT - leftT) / (rightT - leftT) * rightVariance;
  return variance > 0 ? Math.sqrt(variance / targetT) : null;
}

export function annualizedHv20(closes: number[], end: number): number | null {
  if (end < 20) return null;
  const returns = closes.slice(end - 20, end + 1).slice(1).map((close, i) => Math.log(close / closes[end - 20 + i]));
  if (returns.length !== 20 || returns.some(x => !Number.isFinite(x))) return null;
  const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  const sampleVariance = returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(sampleVariance * 252);
}

export function ivRankPercentile(window: Array<number | null>, current: number | null) {
  const valid = window.filter((x): x is number => x != null && Number.isFinite(x));
  if (current == null || !Number.isFinite(current) || valid.length === 0) return { rank: null, percentile: null, sample: valid.length };
  const min = Math.min(...valid), max = Math.max(...valid);
  return { rank: max === min ? null : (current - min) / (max - min) * 100,
    percentile: valid.filter(x => x < current).length / valid.length * 100, sample: valid.length };
}
