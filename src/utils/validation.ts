import type { OptionLeg } from '../models/option';

export function legIsValid(leg: OptionLeg): boolean {
  return legStructureIsValid(leg) &&
    Number.isFinite(leg.premium) && leg.premium >= 0 &&
    Number.isFinite(leg.multiplier) && leg.multiplier > 0 &&
    Number.isFinite(leg.iv) && leg.iv > 0;
}

export function legStructureIsValid(leg: OptionLeg): boolean {
  return (leg.optionType === 'CALL' || leg.optionType === 'PUT') &&
    (leg.side === 'LONG' || leg.side === 'SHORT') &&
    Number.isFinite(leg.strike) && leg.strike >= 0 &&
    Number.isFinite(leg.quantity) && leg.quantity > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(leg.expiry) && !Number.isNaN(new Date(`${leg.expiry}T00:00:00`).getTime());
}
