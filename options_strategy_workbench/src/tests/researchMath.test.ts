import { describe, expect, it } from 'vitest';
import { annualizedHv20, fixedMaturityIv, ivRankPercentile } from '../engine/researchMath';

describe('historical research calculations', () => {
  it('interpolates total variance and does not extrapolate', () => {
    expect(fixedMaturityIv([{dte:20,atmIv:.2},{dte:40,atmIv:.3}],30)).toBeCloseTo(Math.sqrt((.5*.2**2*(20/365)+.5*.3**2*(40/365))/(30/365)),12);
    expect(fixedMaturityIv([{dte:30,atmIv:.24}],30)).toBe(.24);
    expect(fixedMaturityIv([{dte:31,atmIv:.24}],30)).toBeNull();
  });

  it('uses 20 historical log returns and sample standard deviation for HV20', () => {
    expect(annualizedHv20(Array.from({length:20},(_,i)=>100+i),19)).toBeNull();
    const closes=Array.from({length:21},(_,i)=>100*Math.exp(.001*i));
    expect(annualizedHv20(closes,20)).toBeCloseTo(0,10);
    const varied=[100,101,99,102,98,103,97,104,96,105,95,106,94,107,93,108,92,109,91,110,90];
    expect(annualizedHv20(varied,20)).toBeGreaterThan(0);
  });

  it('includes current IV, ignores missing samples, and guards constant ranges', () => {
    const metrics=ivRankPercentile([.1,.2,.3,null],.2);expect(metrics.rank).toBeCloseTo(50);expect(metrics.percentile).toBeCloseTo(33.33333333333333);expect(metrics.sample).toBe(3);
    expect(ivRankPercentile([.2,.2,null],.2)).toEqual({rank:null,percentile:0,sample:2});
    expect(ivRankPercentile([null],null)).toEqual({rank:null,percentile:null,sample:0});
  });
});
