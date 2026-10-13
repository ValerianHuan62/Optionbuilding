import type { OptionLeg } from '../models/option';

export type Strategy = { name: string; chinese: string; bias: string; legs: number };
export function shouldNotifyStrategy(previous: string | null | undefined, current: string | null): boolean {
  return previous !== undefined && current !== null && current !== previous;
}
type L = Pick<OptionLeg, 'optionType' | 'side' | 'strike' | 'quantity' | 'expiry'>;
const sameExpiry = (a: L[]) => new Set(a.map(x => x.expiry)).size <= 1;
const netted = (legs: L[]) => {
  const map = new Map<string, number>();
  for (const l of legs) {
    const key = [l.optionType, l.strike, l.expiry].join('|');
    map.set(key, (map.get(key) ?? 0) + (l.side === 'LONG' ? 1 : -1) * l.quantity);
  }
  return [...map].flatMap(([key, q]) => {
    if (Math.abs(q) < 1e-8) return [];
    const [optionType, strike, expiry] = key.split('|');
    return [{ optionType: optionType as L['optionType'], strike: +strike, expiry, side: q > 0 ? 'LONG' as const : 'SHORT' as const, quantity: Math.abs(q) }];
  });
};
const sorted = (xs: L[]) => [...xs].sort((a, b) => a.strike - b.strike);
const exact = (xs: L[], shape: Array<[L['optionType'], L['side'], number]>) => xs.length === shape.length && xs.every((l, i) => l.optionType === shape[i][0] && l.side === shape[i][1] && Math.abs(l.quantity - shape[i][2]) < 1e-8);
function classifySameExpiry(xs: L[]): Strategy | null {
  if (!xs.length) return null;
  if (xs.length === 1) {
    const l = xs[0]; return { name: `${l.side === 'LONG' ? 'LONG' : 'SHORT'} ${l.optionType}`, chinese: `${l.side === 'LONG' ? '买入' : '卖出'}看${l.optionType === 'CALL' ? '涨' : '跌'}`, bias: l.optionType === 'CALL' ? (l.side === 'LONG' ? 'BULLISH' : 'BEARISH') : (l.side === 'LONG' ? 'BEARISH' : 'BULLISH'), legs: 1 };
  }
  if (!sameExpiry(xs)) return null;
  if (xs.length === 2) {
    const [a, b] = sorted(xs);
    if (a.optionType === b.optionType && a.quantity === b.quantity && a.side !== b.side) {
      const long = a.side === 'LONG' ? a : b, short = a.side === 'SHORT' ? a : b;
      if (a.optionType === 'CALL') return { name: long.strike < short.strike ? 'BULL CALL SPREAD' : 'BEAR CALL SPREAD', chinese: long.strike < short.strike ? '牛市看涨价差' : '熊市看涨价差', bias: long.strike < short.strike ? 'BULLISH' : 'BEARISH', legs: 2 };
      return { name: long.strike < short.strike ? 'BULL PUT SPREAD' : 'BEAR PUT SPREAD', chinese: long.strike < short.strike ? '牛市看跌价差' : '熊市看跌价差', bias: long.strike < short.strike ? 'BULLISH' : 'BEARISH', legs: 2 };
    }
    if (a.strike === b.strike && a.optionType !== b.optionType && a.side === b.side && a.quantity === b.quantity) return { name: `${a.side} STRADDLE`, chinese: `${a.side === 'LONG' ? '买入' : '卖出'}跨式`, bias: a.side === 'LONG' ? 'VOLATILITY LONG' : 'VOLATILITY SHORT', legs: 2 };
    if (a.optionType !== b.optionType && a.side === b.side && a.quantity === b.quantity && a.strike !== b.strike) return { name: `${a.side} STRANGLE`, chinese: `${a.side === 'LONG' ? '买入' : '卖出'}宽跨式`, bias: a.side === 'LONG' ? 'VOLATILITY LONG' : 'VOLATILITY SHORT', legs: 2 };
    if (a.optionType === b.optionType && a.side !== b.side && a.quantity !== b.quantity && a.strike !== b.strike) return { name: `${a.optionType} RATIO SPREAD`, chinese: `${a.optionType === 'CALL' ? '看涨' : '看跌'}比例价差`, bias: a.optionType === 'CALL' ? 'DIRECTIONAL / SHORT VOL' : 'DIRECTIONAL / SHORT VOL', legs: 2 };
    return null;
  }
  if (xs.length === 3) {
    const [a, b, c] = sorted(xs);
    const butterfly = a.optionType === b.optionType && b.optionType === c.optionType && a.strike < b.strike && b.strike < c.strike && a.side === c.side && a.side !== b.side && a.quantity === c.quantity && b.quantity === 2 * a.quantity && Math.abs((b.strike - a.strike) - (c.strike - b.strike)) < 1e-8;
    if (butterfly) return { name: `${a.side} ${a.optionType} BUTTERFLY`, chinese: `${a.side === 'LONG' ? '多头' : '空头'}${a.optionType === 'CALL' ? '看涨' : '看跌'}蝶式`, bias: 'RANGE / VOLATILITY', legs: 3 };
    const straddleSide = xs.every(x => x.side === xs[0].side && x.quantity === xs[0].quantity);
    if (straddleSide && xs.filter(x => x.optionType === 'CALL').length === 1 && xs.filter(x => x.optionType === 'PUT').length === 2) return null;
  }
  if (xs.length === 4) {
    const calls = xs.filter(x => x.optionType === 'CALL'), puts = xs.filter(x => x.optionType === 'PUT');
    const orderedPuts = sorted(puts), orderedCalls = sorted(calls);
    if (puts.length === 2 && calls.length === 2 && orderedPuts[1].strike === orderedCalls[0].strike && orderedPuts[0].strike < orderedPuts[1].strike && orderedCalls[0].strike < orderedCalls[1].strike) {
      const [lp, sp] = orderedPuts, [sc, lc] = orderedCalls;
      const equal = [lp, sp, sc, lc].every(x => x.quantity === lp.quantity);
      if (equal && lp.side === 'LONG' && sp.side === 'SHORT' && sc.side === 'SHORT' && lc.side === 'LONG') return { name: 'LONG IRON BUTTERFLY', chinese: '多头铁蝶式', bias: 'RANGE / VOLATILITY LONG', legs: 4 };
      if (equal && lp.side === 'SHORT' && sp.side === 'LONG' && sc.side === 'LONG' && lc.side === 'SHORT') return { name: 'SHORT IRON BUTTERFLY', chinese: '空头铁蝶式', bias: 'RANGE / VOLATILITY SHORT', legs: 4 };
    }
    const lcondor = xs.length === 4 && calls.length === 2 && puts.length === 2;
    if (lcondor) {
      const byK = sorted(xs);
      const [a,b,c,d] = byK;
      if (new Set(byK.map(x => x.strike)).size === 4 && a.optionType === 'PUT' && b.optionType === 'PUT' && c.optionType === 'CALL' && d.optionType === 'CALL' && a.side === 'LONG' && b.side === 'SHORT' && c.side === 'SHORT' && d.side === 'LONG' && [a.quantity,b.quantity,c.quantity].every(q => q === d.quantity)) return { name: 'LONG IRON CONDOR', chinese: '多头铁鹰式', bias: 'RANGE / VOLATILITY LONG', legs: 4 };
      if (new Set(byK.map(x => x.strike)).size === 4 && a.optionType === 'PUT' && b.optionType === 'PUT' && c.optionType === 'CALL' && d.optionType === 'CALL' && a.side === 'SHORT' && b.side === 'LONG' && c.side === 'LONG' && d.side === 'SHORT' && [a.quantity,b.quantity,c.quantity].every(q => q === d.quantity)) return { name: 'SHORT IRON CONDOR', chinese: '空头铁鹰式', bias: 'RANGE / VOLATILITY SHORT', legs: 4 };
    }
  }
  return null;
}
export function classifyStrategy(legs: L[]): Strategy | null {
  if (!legs.length) return null;
  const normalized = netted(legs);
  if (!normalized.length) return null;
  if (new Set(normalized.map(l => l.expiry)).size > 1) {
    if (normalized.length === 2 && normalized[0].optionType === normalized[1].optionType && normalized[0].side !== normalized[1].side && normalized[0].quantity === normalized[1].quantity) {
      const sameStrike = normalized[0].strike === normalized[1].strike;
      return { name: sameStrike ? 'CALENDAR SPREAD' : 'DIAGONAL SPREAD', chinese: sameStrike ? '日历价差' : '对角价差', bias: 'TIME SPREAD', legs: 2 };
    }
    return { name: 'CUSTOM STRATEGY', chinese: '自定义组合', bias: 'MIXED EXPOSURE', legs: normalized.length };
  }
  return classifySameExpiry(normalized) ?? { name: 'CUSTOM STRATEGY', chinese: '自定义组合', bias: 'MIXED EXPOSURE', legs: normalized.length };
}
