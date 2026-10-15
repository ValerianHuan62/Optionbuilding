import type { OptionLeg } from '../models/option';

export type ScenarioGrid = { ps: number[]; vs: number[]; z: (number | null)[][] };

export function commonPriceGrid(spot: number, strikes: number[], count = 101): number[] {
  const low = Math.max(0, Math.min(spot, ...strikes) * .75);
  const high = Math.max(spot, ...strikes, 1) * 1.25;
  return Array.from({ length: count }, (_, i) => low + (high - low) * i / Math.max(1, count - 1));
}

export function calculateScenarioGrid(spot: number, evaluate: (spot: number, ivShiftPp: number) => number | null, priceCount = 15, ivCount = 13): ScenarioGrid {
  const ps = Array.from({ length: priceCount }, (_, i) => -10 + i * 20 / Math.max(1, priceCount - 1));
  const vs = Array.from({ length: ivCount }, (_, i) => -10 + i * 20 / Math.max(1, ivCount - 1));
  return { ps, vs, z: vs.map(v => ps.map(p => evaluate(spot * (1 + p / 100), v))) };
}

export function hasCommonExpiry(legs: OptionLeg[]): boolean {
  return new Set(legs.map(leg => leg.expiry)).size <= 1;
}
