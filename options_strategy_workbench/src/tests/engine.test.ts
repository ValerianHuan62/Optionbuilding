import { describe, expect, it } from 'vitest';
import type { OptionLeg } from '../models/option';
import { grossExpirationPnl, legExpirationPnl } from '../engine/payoff';
import { analyzePayoff } from '../engine/payoffAnalyzer';
import { classifyStrategy, shouldNotifyStrategy } from '../engine/strategyClassifier';
import { aggregateGreeks, legGreeks, priceOption } from '../engine/pricing';
import { scenarioPnl } from '../engine/scenario';
import { legIsValid, legStructureIsValid } from '../utils/validation';

const leg = (o: Partial<OptionLeg> = {}): OptionLeg => ({ id: crypto.randomUUID(), optionType:'CALL', side:'LONG', strike:100, premium:10, quantity:1, multiplier:100, expiry:'2026-12-24', iv:.2, greeks:{}, ...o });

describe('input validation boundaries', () => {
  it('keeps strategy identity fields separate from quote and model inputs', () => {
    const original=leg();
    expect(legStructureIsValid(original)).toBe(true);
    expect(legIsValid(original)).toBe(true);
    expect(legStructureIsValid({...original,premium:NaN,iv:NaN})).toBe(true);
    expect(legIsValid({...original,premium:NaN})).toBe(false);
  });
});

describe('expiration payoff and exact analyzer', () => {
  it('calculates long and short calls and puts in yuan', () => {
    expect(legExpirationPnl(leg(),100)).toBe(-1000);
    expect(legExpirationPnl(leg({side:'SHORT'}),120)).toBe(-1000);
    expect(legExpirationPnl(leg({optionType:'PUT',premium:5}),80)).toBe(1500);
    expect(legExpirationPnl(leg({optionType:'PUT',side:'SHORT',premium:5}),80)).toBe(-1500);
  });
  it('uses quantity and multiplier, and finds exact unlimited upside and break-even', () => {
    const a = analyzePayoff([leg({ quantity:2, multiplier:50 })]);
    expect(grossExpirationPnl([leg({quantity:2,multiplier:50})],120)).toBe(1000);
    expect(a.maxProfit).toBe('UNLIMITED'); expect(a.maxLoss).toBe(-1000); expect(a.breakEvens).toEqual([110]);
  });
  it('finds a bull call spread exact PnL extrema and break-even', () => {
    const legs=[leg({strike:100,premium:12}),leg({id:'s',side:'SHORT',strike:120,premium:5})];
    const a=analyzePayoff(legs);
    expect(a.netDebit).toBe(700); expect(a.maxProfit).toBe(1300); expect(a.maxLoss).toBe(-700); expect(a.breakEvens).toEqual([107]);
    expect(a.maxProfitAt).toEqual([120]); expect(a.maxLossAt).toEqual([0,100]);
  });
  it('matches the requested IO spread acceptance example', () => {
    const legs=[leg({strike:4300,premium:50,multiplier:100}),leg({id:'short',side:'SHORT',strike:4400,premium:20,multiplier:100})];
    const a=analyzePayoff(legs);
    expect(classifyStrategy(legs)?.name).toBe('BULL CALL SPREAD');
    expect(a.netDebit).toBe(3000); expect(a.maxProfit).toBe(7000); expect(a.maxLoss).toBe(-3000); expect(a.breakEvens).toEqual([4330]);
  });
  it('supports multiple roots and recognizes bounded losses below zero', () => {
    const a=analyzePayoff([leg({side:'SHORT',optionType:'CALL',strike:100,premium:15}),leg({id:'p',side:'SHORT',optionType:'PUT',strike:100,premium:15})]);
    expect(a.breakEvens).toEqual([70,130]);
    const shortPut=analyzePayoff([leg({optionType:'PUT',side:'SHORT',premium:5})]);
    expect(shortPut.maxProfit).toBe(500); expect(shortPut.maxLoss).toBe(-9500);
  });
  it('keeps the expiration payoff gross even when cost inputs are supplied', () => {
    const a=analyzePayoff([leg()],{openPerContract:2,closePerContract:99,settlementPerContract:3});
    expect(a.maxLoss).toBe(-1000); expect(a.points.find(p=>p.x===0)?.y).toBe(-1000);
  });
});

describe('rule-based strategy classification', () => {
  it('recognizes long/short singles, directional spreads, straddles and strangles', () => {
    expect(classifyStrategy([leg()])?.name).toBe('LONG CALL');
    expect(classifyStrategy([leg({side:'SHORT',optionType:'PUT'})])?.name).toBe('SHORT PUT');
    expect(classifyStrategy([leg({strike:100,premium:12}),leg({id:'s',side:'SHORT',strike:120,premium:4})])?.name).toBe('BULL CALL SPREAD');
    expect(classifyStrategy([leg({side:'SHORT',strike:100}),leg({id:'l',side:'LONG',strike:120})])?.name).toBe('BEAR CALL SPREAD');
    expect(classifyStrategy([leg({optionType:'PUT',side:'SHORT',strike:120}),leg({id:'l',optionType:'PUT',side:'LONG',strike:100})])?.name).toBe('BULL PUT SPREAD');
    expect(classifyStrategy([leg({optionType:'PUT',side:'LONG',strike:120}),leg({id:'l',optionType:'PUT',side:'SHORT',strike:100})])?.name).toBe('BEAR PUT SPREAD');
    expect(classifyStrategy([leg({strike:100}),leg({id:'p',optionType:'PUT',strike:100})])?.name).toBe('LONG STRADDLE');
    expect(classifyStrategy([leg({strike:100}),leg({id:'p',optionType:'PUT',strike:90})])?.name).toBe('LONG STRANGLE');
  });
  it('recognizes both iron condor directions, butterflies, ratio and calendar structures', () => {
    const condor=[leg({optionType:'PUT',strike:80}),leg({id:'p2',optionType:'PUT',side:'SHORT',strike:90}),leg({id:'c1',side:'SHORT',strike:110}),leg({id:'c2',side:'LONG',strike:120})];
    expect(classifyStrategy(condor)?.name).toBe('LONG IRON CONDOR');
    expect(classifyStrategy(condor.map(x=>({...x,side:x.side==='LONG'?'SHORT' as const:'LONG' as const})))?.name).toBe('SHORT IRON CONDOR');
    expect(classifyStrategy([leg({strike:90}),leg({id:'b',side:'SHORT',strike:100,quantity:2}),leg({id:'c',strike:110})])?.name).toBe('LONG CALL BUTTERFLY');
    expect(classifyStrategy([leg({optionType:'PUT',strike:90}),leg({id:'b',optionType:'PUT',side:'SHORT',strike:100,quantity:2}),leg({id:'c',optionType:'PUT',strike:110})])?.name).toBe('LONG PUT BUTTERFLY');
    const ironFly=[leg({optionType:'PUT',strike:90}),leg({id:'p-atm',optionType:'PUT',side:'SHORT',strike:100}),leg({id:'c-atm',side:'SHORT',strike:100}),leg({id:'c-wing',side:'LONG',strike:110})];
    expect(classifyStrategy(ironFly)?.name).toBe('LONG IRON BUTTERFLY');
    expect(classifyStrategy(ironFly.map(x=>({...x,side:x.side==='LONG'?'SHORT' as const:'LONG' as const})))?.name).toBe('SHORT IRON BUTTERFLY');
    expect(classifyStrategy([leg({strike:90,quantity:2}),leg({id:'r',side:'SHORT',strike:100,quantity:1})])?.name).toBe('CALL RATIO SPREAD');
    expect(classifyStrategy([leg({expiry:'2026-11-27'}),leg({id:'cal',side:'SHORT',expiry:'2026-12-24'})])?.name).toBe('CALENDAR SPREAD');
    expect(classifyStrategy([leg({expiry:'2026-11-27',strike:100}),leg({id:'diag',side:'SHORT',strike:110,expiry:'2026-12-24'})])?.name).toBe('DIAGONAL SPREAD');
  });
  it('does not force an unmatched structure into a named pattern', () => {
    expect(classifyStrategy([leg(),leg({id:'x',side:'SHORT',optionType:'PUT',strike:130})])?.name).toBe('CUSTOM STRATEGY');
  });
  it('notifies only on a strategy name transition', () => {
    expect(shouldNotifyStrategy(undefined,'LONG CALL')).toBe(false);
    expect(shouldNotifyStrategy(null,'LONG CALL')).toBe(true);
    expect(shouldNotifyStrategy('LONG CALL','LONG CALL')).toBe(false);
    expect(shouldNotifyStrategy('LONG CALL','BULL CALL SPREAD')).toBe(true);
    expect(shouldNotifyStrategy('LONG CALL',null)).toBe(false);
  });
});

describe('model pricing, Greeks and scenarios', () => {
  const base={spot:100,forward:100,rate:0,dividend:0,days:365,model:'BSM' as const};
  it('prices BSM call and Black-76 call, with stable ATM Greeks', () => {
    const q=priceOption(leg({strike:100,iv:.2}),base);
    expect(q.value).toBeCloseTo(7.9656,2); expect(q.greeks?.delta).toBeCloseTo(.5398,2); expect(q.greeks?.gamma).toBeGreaterThan(0);
    const b76=priceOption(leg({strike:100,iv:.2}),{...base,rate:3,model:'BLACK76'});
    expect(b76.value).toBeGreaterThan(0); expect(b76.greeks?.vega).toBeGreaterThan(0);
  });
  it('handles expiry, invalid IV, and raw point Greek units', () => {
    expect(priceOption(leg(),{...base,days:0}).value).toBe(0);
    expect(Number.isNaN(priceOption(leg({iv:0}),base).value)).toBe(true);
    const values=legGreeks(leg({greeks:{delta:.5,gamma:.01,theta:-.02,vega:4,rho:6}}),base,'MANUAL','KUAIQI_RAW');
    expect(values.delta).toBe(.5); expect(values.vega).toBe(4); expect(values.rho).toBe(6);
    expect(aggregateGreeks([values,{...values,delta:null}]).delta).toBeNull();
    expect(aggregateGreeks([]).vega).toBeNull();
  });
  it('marks scenarios from actual entry premium and rejects invalid IV shifts', () => {
    const scenario={spot:100,forward:100,valuationDate:'2026-10-12',daysForward:0,ivShift:0,rate:0,dividend:0,model:'BSM' as const,openFees:0,closePerContract:0,settlementPerContract:0};
    const l=leg({strike:100,premium:7.9656,expiry:'2027-10-12',iv:.2});
    expect(scenarioPnl([l],scenario)).toBeCloseTo(0,1);
    expect(scenarioPnl([l],{...scenario,ivShift:-.2})).toBeNull();
  });
  it('settles legs that expire before the shared scenario date', () => {
    const l=leg({strike:100,premium:5,expiry:'2026-12-24'});
    const pnl=scenarioPnl([l],{spot:120,forward:120,valuationDate:'2026-10-12',daysForward:80,ivShift:0,rate:0,dividend:0,model:'BSM',openFees:0,closePerContract:0,settlementPerContract:0});
    expect(pnl).toBe(1500);
  });
  it('uses per-leg days-to-expiry overrides from the workbench', () => {
    const l=leg({strike:100,premium:5,expiry:'2027-12-24'});
    const pnl=scenarioPnl([l],{spot:120,forward:120,valuationDate:'2026-10-12',daysToExpiryByLeg:{[l.id]:1},daysForward:2,ivShift:0,rate:0,dividend:0,model:'BSM',openFees:0,closePerContract:0,settlementPerContract:0});
    expect(pnl).toBe(1500);
  });
});
