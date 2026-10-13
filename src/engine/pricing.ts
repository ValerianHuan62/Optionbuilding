import type { GreekValues, OptionLeg, PricingModel } from '../models/option';
import { intrinsic, sign } from './payoff';

const SQRT2 = Math.sqrt(2), SQRT2PI = Math.sqrt(2 * Math.PI);
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return s * y;
}
export const normalCdf = (x: number) => 0.5 * (1 + erf(x / SQRT2));
export const normalPdf = (x: number) => Math.exp(-0.5 * x * x) / SQRT2PI;
export type ModelInputs = { spot: number; forward: number; rate: number; dividend: number; days: number; model: PricingModel };
export type OptionQuote = { value: number; greeks: Omit<GreekValues, 'vega'> & { vega: number } | null };

/** Rates are entered in percentage units (2 means 2%); IV is decimal (0.2 means 20%). */
export function priceOption(leg: Pick<OptionLeg, 'optionType' | 'strike' | 'iv'>, input: ModelInputs): OptionQuote {
  const { spot, forward, days, model } = input;
  const r = input.rate / 100, q = input.dividend / 100, t = Math.max(0, days) / 365, sigma = leg.iv;
  if (days <= 0) return { value: intrinsic(leg.optionType, model === 'BLACK76' ? forward : spot, leg.strike), greeks: null };
  if (spot <= 0 || leg.strike <= 0 || sigma <= 0 || !Number.isFinite(sigma)) return { value: NaN, greeks: null };
  const rootT = Math.sqrt(t), discount = Math.exp(-r * t), isCall = leg.optionType === 'CALL';
  if (model === 'BLACK76') {
    if (forward <= 0) return { value: NaN, greeks: null };
    const d1 = (Math.log(forward / leg.strike) + 0.5 * sigma * sigma * t) / (sigma * rootT), d2 = d1 - sigma * rootT;
    const value = discount * (isCall ? forward * normalCdf(d1) - leg.strike * normalCdf(d2) : leg.strike * normalCdf(-d2) - forward * normalCdf(-d1));
    const deltaF = discount * (isCall ? normalCdf(d1) : normalCdf(d1) - 1);
    const chain = forward / spot;
    const gamma = discount * normalPdf(d1) / (forward * sigma * rootT) * chain * chain;
    const vega = discount * forward * normalPdf(d1) * rootT;
    const thetaYear = r * value - discount * forward * normalPdf(d1) * sigma / (2 * rootT);
    const rhoYear = -t * value;
    return { value, greeks: { delta: deltaF * chain, gamma, theta: thetaYear / 365, vega, rho: rhoYear } };
  }
  const d1 = (Math.log(spot / leg.strike) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * rootT), d2 = d1 - sigma * rootT;
  const eq = Math.exp(-q * t);
  const value = isCall ? spot * eq * normalCdf(d1) - leg.strike * discount * normalCdf(d2) : leg.strike * discount * normalCdf(-d2) - spot * eq * normalCdf(-d1);
  const delta = isCall ? eq * normalCdf(d1) : eq * (normalCdf(d1) - 1);
  const gamma = eq * normalPdf(d1) / (spot * sigma * rootT);
  const vega = spot * eq * normalPdf(d1) * rootT;
  const thetaYear = isCall ? -spot * eq * normalPdf(d1) * sigma / (2 * rootT) - r * leg.strike * discount * normalCdf(d2) + q * spot * eq * normalCdf(d1) : -spot * eq * normalPdf(d1) * sigma / (2 * rootT) + r * leg.strike * discount * normalCdf(-d2) - q * spot * eq * normalCdf(-d1);
  const rhoYear = isCall ? leg.strike * t * discount * normalCdf(d2) : -leg.strike * t * discount * normalCdf(-d2);
  return { value, greeks: { delta, gamma, theta: thetaYear / 365, vega, rho: rhoYear } };
}

export function legGreeks(leg: OptionLeg, input: ModelInputs, mode: 'MANUAL' | 'MODEL'): GreekValues {
  const raw = mode === 'MODEL' ? priceOption(leg, input).greeks : leg.greeks;
  if (!raw) return { delta: null, gamma: null, theta: null, vega: null, rho: null };
  const scale = sign(leg.side) * leg.quantity * leg.multiplier;
  const asNum = (x: number | null | undefined) => { if (x === undefined || x === null || !Number.isFinite(x)) return null; const value=x*scale; return Number.isFinite(value)?value:null; };
  const vega = asNum(raw.vega), rho = asNum(raw.rho);
  return { delta: asNum(raw.delta), gamma: asNum(raw.gamma), theta: asNum(raw.theta), vega: vega === null ? null : vega / 100, rho: rho === null ? null : rho / 100 };
}
export function aggregateGreeks(rows: GreekValues[]): GreekValues {
  const keys: (keyof GreekValues)[] = ['delta','gamma','theta','vega','rho'];
  if (!rows.length) return { delta:null,gamma:null,theta:null,vega:null,rho:null };
  return Object.fromEntries(keys.map(k => [k, rows.every(row => row[k] !== null) ? rows.reduce((s,row) => s + row[k]!, 0) : null])) as GreekValues;
}
