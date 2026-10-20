import type { OptionLeg } from '../models/option';
import { intrinsic, sign } from './payoff';
import { analyzePayoff } from './payoffAnalyzer';
import { priceOption } from './pricing';

export type ScenarioBasis = 'MODEL' | 'MARKET';
export type ScenarioInput = { spot: number; valuationDate: string; daysToExpiryByLeg?: Record<string,number>; daysForward: number; ivShift: number; rate: number; dividend: number; basis?: ScenarioBasis; openFees?: number; closePerContract?: number; settlementPerContract?: number };
export type ScenarioLegDiagnostic = { contractId:string; optionType:string; side:string; quantity:number; multiplier:number; mid:number; spot:number; strike:number; rate:number; dividend:number; timeYears:number; iv:number; baseBsm:number|null; scenarioBsm:number|null; bsmMidGap:number|null; gapContribution:number|null; modelPnl:number|null; marketPnl:number|null; qStatus:string };
export type ScenarioDiagnostics = { modelPnl:number|null; marketPnl:number|null; initialMarketValue:number; initialModelValue:number|null; modelMarketGap:number|null; legs:ScenarioLegDiagnostic[] };
const utcDay = (date: string) => { const [year, month, day] = date.split('-').map(Number); return Date.UTC(year, month - 1, day); };
export function scenarioPnlDiagnostics(legs: OptionLeg[], input: ScenarioInput): ScenarioDiagnostics {
  let modelPnl = 0, marketPnl = 0, initialMarketValue = 0, initialModelValue = 0;
  let hasModelValue = true, hasScenarioValue = true;
  const diagnostics: ScenarioLegDiagnostic[] = [];
  const remainingDays: number[] = [];
  for (const leg of legs) {
    const expiryDays = Math.max(0, leg.modelTime != null ? leg.modelTime * 365 : input.daysToExpiryByLeg?.[leg.id] ?? (utcDay(leg.expiry) - utcDay(input.valuationDate)) / 86400000);
    const remaining = Math.max(0, expiryDays - input.daysForward);
    remainingDays.push(remaining);
    const iv = leg.iv + input.ivShift;
    const baseSpot = leg.modelSpot ?? input.spot;
    const baseRate = leg.modelRate != null ? leg.modelRate * 100 : input.rate;
    const q = leg.dividendYield != null ? leg.dividendYield * 100 : input.dividend;
    const baseTime = leg.modelTime != null ? leg.modelTime * 365 : expiryDays;
    const canPrice = Number.isFinite(baseSpot) && baseSpot > 0 && Number.isFinite(baseRate) && Number.isFinite(q) && Number.isFinite(leg.iv) && leg.iv > 0;
    const base = canPrice ? (baseTime <= 0 ? intrinsic(leg.optionType, baseSpot, leg.strike) : priceOption(leg, { spot: baseSpot, rate: baseRate, dividend: q, days: baseTime }).value) : Number.NaN;
    const scenarioSpot = input.spot;
    const scenarioRate = baseRate;
    const scenario = canPrice && (remaining === 0 || iv > 0) ? (remaining === 0 ? intrinsic(leg.optionType, scenarioSpot, leg.strike) : priceOption({ ...leg, iv }, { spot: scenarioSpot, rate: scenarioRate, dividend: q, days: remaining }).value) : Number.NaN;
    const signQty = sign(leg.side) * leg.quantity * leg.multiplier;
    const validBase = Number.isFinite(base), validScenario = Number.isFinite(scenario);
    if (!validBase) hasModelValue = false; else initialModelValue += signQty * base;
    if (!validScenario) hasScenarioValue = false;
    const marketMid=leg.marketEntryPremium??leg.premium;
    initialMarketValue += signQty * marketMid;
    if (validBase && validScenario) modelPnl += signQty * (scenario - base);
    if (validScenario) marketPnl += signQty * (scenario - marketMid);
    diagnostics.push({contractId:leg.id.split(':')[0], optionType:leg.optionType, side:leg.side, quantity:leg.quantity, multiplier:leg.multiplier,
      mid:marketMid, spot:baseSpot, strike:leg.strike, rate:baseRate, dividend:q, timeYears:baseTime/365, iv:leg.iv,
      baseBsm:validBase?base:null, scenarioBsm:validScenario?scenario:null, bsmMidGap:validBase?base-marketMid:null,
      gapContribution:validBase?signQty*(base-marketMid):null, modelPnl:validBase&&validScenario?signQty*(scenario-base):null,
      marketPnl:validScenario?signQty*(scenario-marketMid):null, qStatus:leg.qStatus??(leg.dividendYield!=null?'DATABASE':'MANUAL_OR_EXTERNAL')});
  }
  if (!hasModelValue || !hasScenarioValue) return {modelPnl:null,marketPnl:null,initialMarketValue,initialModelValue:hasModelValue?initialModelValue:null,modelMarketGap:null,legs:diagnostics};
  // A common-expiry portfolio is a discounted expectation of its terminal payoff.
  // Independent strike IVs can violate that bound; reject the inconsistent surface
  // instead of reporting an impossible spread profit or clipping the PnL.
  if (legs.length && new Set(legs.map(leg => leg.expiry)).size === 1 && new Set(remainingDays).size === 1) {
    const payoff = analyzePayoff(legs.map(leg=>({...leg,premium:leg.marketEntryPremium??leg.premium})));
    const discount = Math.exp(-input.rate / 100 * remainingDays[0] / 365);
    const tolerance = Math.max(0.1, legs.reduce((sum, leg) => sum + leg.quantity * leg.multiplier, 0) * input.spot * 1e-7);
    const lower = payoff.maxLoss === 'UNLIMITED' ? -Infinity : discount * (payoff.maxLoss + payoff.netDebit) - payoff.netDebit;
    const upper = payoff.maxProfit === 'UNLIMITED' ? Infinity : discount * (payoff.maxProfit + payoff.netDebit) - payoff.netDebit;
    if (marketPnl < lower - tolerance || marketPnl > upper + tolerance) marketPnl = Number.NaN;
  }
  return {modelPnl,marketPnl:Number.isFinite(marketPnl)?marketPnl:null,initialMarketValue,initialModelValue,
    modelMarketGap:initialModelValue-initialMarketValue,legs:diagnostics};
}

export function scenarioPnl(legs: OptionLeg[], input: ScenarioInput): number | null {
  const result=scenarioPnlDiagnostics(legs,input);
  return input.basis==='MODEL'?result.modelPnl:result.marketPnl;
}
