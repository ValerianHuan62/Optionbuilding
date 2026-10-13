import type { Costs, OptionLeg } from '../models/option';
import { grossExpirationPnl, netPremium, sign } from './payoff';

export type PayoffAnalysis = {
  points: { x: number; y: number }[];
  breakEvens: number[];
  maxProfit: number | 'UNLIMITED';
  maxLoss: number | 'UNLIMITED';
  maxProfitAt: number[] | 'UNLIMITED';
  maxLossAt: number[] | 'UNLIMITED';
  netPremium: number;
  netDebit: number;
  isMultiExpiry: boolean;
  expiry: string | null;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;

export function analyzePayoff(legs: OptionLeg[], costs?: Costs, pricePoints?: number[]): PayoffAnalysis {
  const expiries = [...new Set(legs.map(l => l.expiry).filter(Boolean))];
  const isMultiExpiry = expiries.length > 1;
  const strikes = [...new Set(legs.map(l => l.strike).filter(k => Number.isFinite(k) && k >= 0))].sort((a, b) => a - b);
  const knots = [...new Set([0, ...strikes])].sort((a, b) => a - b);
  const openFees = legs.reduce((s, l) => s + l.quantity * costs?.openPerContract!, 0);
  const settleFees = legs.reduce((s, l) => s + l.quantity * costs?.settlementPerContract!, 0);
  const feeTotal = (Number.isFinite(openFees) ? openFees : 0) + (Number.isFinite(settleFees) ? settleFees : 0);
  const yAt = (x: number) => grossExpirationPnl(legs, x) - feeTotal;
  const breakEvens: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const x0 = knots[i], y0 = yAt(x0);
    if (near(y0, 0)) breakEvens.push(x0);
    if (i + 1 < knots.length) {
      const x1 = knots[i + 1], y1 = yAt(x1);
      if (y0 * y1 < 0) breakEvens.push(x0 + (x1 - x0) * (-y0) / (y1 - y0));
    }
  }
  const slopeAtInfinity = legs.reduce((s, l) => s + (l.optionType === 'CALL' ? sign(l.side) * l.quantity * l.multiplier : 0), 0);
  const terminal = yAt(knots[knots.length - 1] ?? 0);
  if (Math.abs(slopeAtInfinity) > 1e-8 && knots.length > 0) {
    const last = knots[knots.length - 1];
    if (near(terminal, 0) && near(yAt(last - 1), 0)) breakEvens.push(last);
    const root = last - terminal / slopeAtInfinity;
    if (root >= last - 1e-7 && Number.isFinite(root)) breakEvens.push(Math.max(last, root));
  }
  const candidate = [...knots];
  const values = candidate.map(yAt);
  const tailUp = slopeAtInfinity > 1e-8, tailDown = slopeAtInfinity < -1e-8;
  const chartMax = Math.max(legs.length ? Math.max(...legs.map(l => l.strike)) * 1.5 : 100, 100);
  const xs = [...new Set([0, chartMax, ...(pricePoints ?? []), ...strikes])].filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const points = xs.map(x => ({ x, y: yAt(x) }));
  const maxProfit: number | 'UNLIMITED' = tailUp ? 'UNLIMITED' : Math.max(...values);
  const maxLoss: number | 'UNLIMITED' = tailDown ? 'UNLIMITED' : Math.min(...values);
  const maxProfitAt: number[] | 'UNLIMITED' = tailUp ? 'UNLIMITED' : knots.filter((x,i) => near(values[i], maxProfit as number));
  const maxLossAt: number[] | 'UNLIMITED' = tailDown ? 'UNLIMITED' : knots.filter((x,i) => near(values[i], maxLoss as number));
  return { points, breakEvens: [...new Set(breakEvens.map(x => Math.round(x * 1e8) / 1e8))], maxProfit, maxLoss, maxProfitAt, maxLossAt, netPremium: netPremium(legs), netDebit: -netPremium(legs), isMultiExpiry, expiry: expiries.length === 1 ? expiries[0] : null };
}
