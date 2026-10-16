import type { OptionLeg } from '../models/option';
import { intrinsic, sign } from './payoff';
import { analyzePayoff } from './payoffAnalyzer';
import { priceOption } from './pricing';

export type ScenarioInput = { spot: number; valuationDate: string; daysToExpiryByLeg?: Record<string,number>; daysForward: number; ivShift: number; rate: number; dividend: number; openFees?: number; closePerContract?: number; settlementPerContract?: number };
const utcDay = (date: string) => { const [year, month, day] = date.split('-').map(Number); return Date.UTC(year, month - 1, day); };
export function scenarioPnl(legs: OptionLeg[], input: ScenarioInput): number | null {
  let pnl = 0;
  const remainingDays: number[] = [];
  for (const leg of legs) {
    const expiryDays = Math.max(0, input.daysToExpiryByLeg?.[leg.id] ?? (utcDay(leg.expiry) - utcDay(input.valuationDate)) / 86400000);
    const remaining = Math.max(0, expiryDays - input.daysForward);
    remainingDays.push(remaining);
    const iv = leg.iv + input.ivShift;
    if (remaining > 0 && iv <= 0) return null;
    const mark = remaining === 0 ? intrinsic(leg.optionType, input.spot, leg.strike) : priceOption({ ...leg, iv }, { spot: input.spot, rate: input.rate, dividend: input.dividend, days: remaining }).value;
    if (!Number.isFinite(mark)) return null;
    pnl += sign(leg.side) * (mark - leg.premium) * leg.quantity * leg.multiplier;
  }
  // A common-expiry portfolio is a discounted expectation of its terminal payoff.
  // Independent strike IVs can violate that bound; reject the inconsistent surface
  // instead of reporting an impossible spread profit or clipping the PnL.
  if (legs.length && new Set(legs.map(leg => leg.expiry)).size === 1 && new Set(remainingDays).size === 1) {
    const payoff = analyzePayoff(legs);
    const discount = Math.exp(-input.rate / 100 * remainingDays[0] / 365);
    const tolerance = Math.max(0.1, legs.reduce((sum, leg) => sum + leg.quantity * leg.multiplier, 0) * input.spot * 1e-7);
    const lower = payoff.maxLoss === 'UNLIMITED' ? -Infinity : discount * (payoff.maxLoss + payoff.netDebit) - payoff.netDebit;
    const upper = payoff.maxProfit === 'UNLIMITED' ? Infinity : discount * (payoff.maxProfit + payoff.netDebit) - payoff.netDebit;
    if (pnl < lower - tolerance || pnl > upper + tolerance) return null;
  }
  return pnl;
}
