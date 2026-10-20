import { describe, expect, it } from 'vitest';
import { dividendYieldFor, fixedDividendYield } from '../utils/dividendYield';

describe('dividend yield inputs', () => {
  it('does not apply an instrument-wide fixed rate', () => {
    expect(dividendYieldFor('HO · 上证50', 9)).toBe(9);
    expect(dividendYieldFor('IO · 沪深300', 9)).toBe(9);
    expect(dividendYieldFor('MO · 中证1000', 9)).toBe(9);
    expect(fixedDividendYield('MO · 中证1000')).toBeNull();
  });

  it('keeps the custom index rate editable', () => {
    expect(fixedDividendYield('自定义指数')).toBeNull();
    expect(dividendYieldFor('自定义指数', 1.7)).toBe(1.7);
  });
});
