import { describe, expect, it } from 'vitest';
import { dividendYieldFor, fixedDividendYield } from '../utils/dividendYield';

describe('index dividend yields', () => {
  it('uses the fixed HO, IO and MO rates even with stale saved inputs', () => {
    expect(dividendYieldFor('HO · 上证50', 9)).toBe(2.8);
    expect(dividendYieldFor('IO · 沪深300', 9)).toBe(2.3);
    expect(dividendYieldFor('MO · 中证1000', 9)).toBe(1.1);
  });

  it('keeps the custom index rate editable', () => {
    expect(fixedDividendYield('自定义指数')).toBeNull();
    expect(dividendYieldFor('自定义指数', 1.7)).toBe(1.7);
  });
});
