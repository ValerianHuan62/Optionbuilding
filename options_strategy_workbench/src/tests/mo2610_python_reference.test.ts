import { describe, expect, it } from 'vitest';
import { scenarioPnl } from '../engine/scenario';
import type { OptionLeg } from '../models/option';

// Independent Python BSM values from reports/07_mo2610_python_bsm_reconcile.py.
// The DOCX supplies legs, entry premiums and scenarios; report.csv supplies IVs.
const leg = (id: string, side: OptionLeg['side'], optionType: OptionLeg['optionType'], strike: number, premium: number, iv: number): OptionLeg =>
  ({ id, side, optionType, strike, premium, iv, quantity: 1, multiplier: 100, expiry: '2026-10-16', greeks: {} });

const bearCall = [
  leg('C7000', 'SHORT', 'CALL', 7000, 39.4, .3804),
  leg('C7200', 'LONG', 'CALL', 7200, 6.4, .3885),
];
const ironCondor = [
  leg('C6900', 'SHORT', 'CALL', 6900, 80.8, .3826),
  leg('P6700', 'SHORT', 'PUT', 6700, 21.4, .4399),
  leg('P6500', 'LONG', 'PUT', 6500, 5.6, .5038),
  leg('C7100', 'LONG', 'CALL', 7100, 16.2, .3758),
];

const cases = [
  { name: '①', pricePct: -2, ivPp: -5, bear: 3187.12, iron: 4783.95 },
  { name: '②', pricePct: -5, ivPp: 8, bear: 3282.63, iron: -3010.87 },
  { name: '③', pricePct: 0, ivPp: -8, bear: 2150.44, iron: 3284.16 },
  { name: '④', pricePct: 2, ivPp: -5, bear: -3368.96, iron: -4535.36 },
  { name: '⑤', pricePct: 5, ivPp: 5, bear: -12714.33, iron: -10557.05 },
  { name: '⑥', pricePct: -3, ivPp: 3, bear: 3193.49, iron: 2147.17 },
];

describe('MO2610 report scenarios against independent Python BSM', () => {
  for (const item of cases) {
    it(`matches both strategies in scenario ${item.name}`, () => {
      const spot = 6905.17 * (1 + item.pricePct / 100);
      const input = { spot, valuationDate: '2026-10-14', daysForward: 1,
        ivShift: item.ivPp / 100, rate: 1.65, dividend: 1.1 };
      const bear = scenarioPnl(bearCall, input);
      const iron = scenarioPnl(ironCondor, input);
      expect(bear).not.toBeNull();
      expect(iron).not.toBeNull();
      expect(Math.abs(bear! - item.bear)).toBeLessThan(0.1);
      expect(Math.abs(iron! - item.iron)).toBeLessThan(0.1);
    });
  }
  it('matches Python for the saved C6900/C7100 bear call, which differs from the report spread', () => {
    const savedBearCall = [
      leg('saved-C6900', 'SHORT', 'CALL', 6900, 80.8, .3826),
      leg('saved-C7100', 'LONG', 'CALL', 7100, 16.2, .3758),
    ];
    const actual = scenarioPnl(savedBearCall, {
      spot: 6905.17 * .95, valuationDate: '2026-10-14', daysForward: 1,
      ivShift: .08, rate: 1.66, dividend: 1.1,
    });
    expect(actual).not.toBeNull();
    expect(Math.abs(actual! - 6352.69)).toBeLessThan(.1);
    expect(actual).not.toBeCloseTo(3282.63, 1);
  });
});
