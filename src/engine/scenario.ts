import type { OptionLeg, PricingModel } from '../models/option';
import { intrinsic, sign } from './payoff';
import { priceOption } from './pricing';

export type ScenarioInput = { spot: number; forward: number; valuationDate: string; daysToExpiryByLeg?: Record<string,number>; daysForward: number; ivShift: number; rate: number; dividend: number; model: PricingModel; openFees: number; closePerContract: number; settlementPerContract: number };
export function scenarioPnl(legs: OptionLeg[], input: ScenarioInput): number | null {
  let pnl = -input.openFees;
  for (const leg of legs) {
    const expiryDays = Math.max(0, input.daysToExpiryByLeg?.[leg.id] ?? Math.ceil((new Date(`${leg.expiry}T00:00:00`).getTime() - new Date(`${input.valuationDate}T00:00:00`).getTime()) / 86400000));
    const remaining = Math.max(0, expiryDays - input.daysForward);
    const iv = leg.iv + input.ivShift;
    if (remaining > 0 && iv <= 0) return null;
    const mark = remaining === 0 ? intrinsic(leg.optionType, input.spot, leg.strike) : priceOption({ ...leg, iv }, { spot: input.spot, forward: input.forward, rate: input.rate, dividend: input.dividend, days: remaining, model: input.model }).value;
    if (!Number.isFinite(mark)) return null;
    pnl += sign(leg.side) * (mark - leg.premium) * leg.quantity * leg.multiplier;
    pnl -= (remaining === 0 ? input.settlementPerContract : input.closePerContract) * leg.quantity;
  }
  return pnl;
}
