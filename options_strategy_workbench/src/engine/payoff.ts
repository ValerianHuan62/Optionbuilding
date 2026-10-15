import type { OptionLeg, Side } from '../models/option';

export function sign(side: Side): number { return side === 'LONG' ? 1 : -1; }
export function intrinsic(type: OptionLeg['optionType'], spot: number, strike: number): number {
  return type === 'CALL' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}
export function legExpirationPnl(leg: OptionLeg, spot: number): number {
  return sign(leg.side) * (intrinsic(leg.optionType, spot, leg.strike) - leg.premium) * leg.quantity * leg.multiplier;
}
export function grossExpirationPnl(legs: OptionLeg[], spot: number): number {
  return legs.reduce((total, leg) => total + legExpirationPnl(leg, spot), 0);
}
export function netPremium(legs: OptionLeg[]): number {
  return legs.reduce((sum, leg) => sum - sign(leg.side) * leg.premium * leg.quantity * leg.multiplier, 0);
}
