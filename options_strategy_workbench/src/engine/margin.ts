import type { OptionContract, OptionLeg } from '../models/option';

export type MarginParams = { m: number; minimumRatio: number };
export type MarginLine = { contractId?: string; side: 'SHORT'; optionType: 'CALL' | 'PUT'; strike: number; settlementPrice: number | null; priceSource: 'SETTLEMENT' | 'ESTIMATED_MARKET' | 'MISSING'; quantity: number; multiplier: number; amount: number | null };

export function shortOptionMargin(input: { optionType: 'CALL' | 'PUT'; spot: number; strike: number; settlementPrice: number; multiplier: number; quantity?: number; params: MarginParams }): number {
  const { optionType, spot, strike, settlementPrice, multiplier, params } = input;
  if (![spot, strike, settlementPrice, multiplier, params.m, params.minimumRatio].every(Number.isFinite) || spot < 0 || strike <= 0 || settlementPrice < 0 || multiplier <= 0 || params.m < 0 || params.minimumRatio < 0) return NaN;
  const n = params.m * params.minimumRatio;
  const otm = optionType === 'CALL' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  const floor = optionType === 'CALL' ? spot * n : strike * n;
  const amountPerContract = settlementPrice + Math.max(spot * params.m - otm, floor);
  return amountPerContract * multiplier * (input.quantity ?? 1);
}

export function marginForContract(contract: OptionContract, position: { side: 'LONG' | 'SHORT'; quantity: number }, spot: number, params: MarginParams): MarginLine | null {
  if (position.side !== 'SHORT') return null;
  const hasOfficialSettlement = Number.isFinite(contract.settlementPrice) && contract.settlementPrice! >= 0;
  const marketPremium = contract.marketPremium ?? contract.premium;
  const price = hasOfficialSettlement ? contract.settlementPrice! : marketPremium;
  const source = hasOfficialSettlement ? 'SETTLEMENT' : price === null ? 'MISSING' : 'ESTIMATED_MARKET';
  return { contractId: contract.contractId, side: 'SHORT', optionType: contract.optionType, strike: contract.strike, settlementPrice: price, priceSource: source, quantity: position.quantity, multiplier: contract.multiplier,
    amount: price === null ? null : shortOptionMargin({ optionType: contract.optionType, spot, strike: contract.strike, settlementPrice: price, multiplier: contract.multiplier, quantity: position.quantity, params }) };
}

export function marginForLeg(leg: OptionLeg, spot: number, params: MarginParams, settlementPrice?: number | null): MarginLine | null {
  if (leg.side !== 'SHORT') return null;
  const price = Number.isFinite(settlementPrice) && settlementPrice! >= 0 ? settlementPrice! : null;
  return { side: 'SHORT', optionType: leg.optionType, strike: leg.strike, settlementPrice: price, priceSource: price === null ? 'MISSING' : 'SETTLEMENT', quantity: leg.quantity, multiplier: leg.multiplier,
    amount: price === null ? null : shortOptionMargin({ optionType: leg.optionType, spot, strike: leg.strike, settlementPrice: price, multiplier: leg.multiplier, quantity: leg.quantity, params }) };
}
