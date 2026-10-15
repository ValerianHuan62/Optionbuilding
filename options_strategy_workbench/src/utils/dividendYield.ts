/** Annual dividend yield in percent for the three supported index options. */
export const INDEX_DIVIDEND_YIELDS = {
  'HO · 上证50': 2.8,
  'IO · 沪深300': 2.3,
  'MO · 中证1000': 1.1,
} as const;

export function fixedDividendYield(underlying: string): number | null {
  return INDEX_DIVIDEND_YIELDS[underlying as keyof typeof INDEX_DIVIDEND_YIELDS] ?? null;
}

export function dividendYieldFor(underlying: string, customYield: number): number {
  return fixedDividendYield(underlying) ?? customYield;
}
