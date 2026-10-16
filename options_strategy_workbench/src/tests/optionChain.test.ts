import { describe, expect, it } from 'vitest';
import type { OptionLeg, WorkbenchState } from '../models/option';
import { legsFromChain, migrateWorkbenchState, parseOptionChainText } from '../utils/optionChain';
import { analyzePayoff } from '../engine/payoffAnalyzer';
import { classifyStrategy } from '../engine/strategyClassifier';

const defaults: WorkbenchState = { underlying:'IO · 沪深300', spot:4300, forward:4300, expiry:'2026-12-24', daysToExpiry:73, multiplier:100,
  model:'BSM', riskFreeRate:1.65, dividendYield:1.8, greeksMode:'MANUAL', costs:{openPerContract:0,closePerContract:0,settlementPerContract:0}, optionChain:[], activeStrategy:[] };
const sample = `strike,callPremium,putPremium,callIV,putIV,callDelta,putDelta,callGamma,putGamma,callVega,putVega,callTheta,putTheta\n4100,224,24,18,20,0.816,-0.184,0.00113,0.00120,3.28,3.10,-1.04,-1.01\n4200,142,42,19,21,0.694,-0.306,0.00167,0.00172,4.32,4.19,-1.23,-1.20\n4300,76.2,76.2,20,22,0.509,-0.491,0.00209,0.00220,4.92,4.80,-1.27,-1.25\n4400,32.8,132.8,21,23,0.297,-0.703,0.00194,0.00188,4.27,4.01,-1.03,-0.98\n4500,11.4,211.4,22,24,0.133,-0.867,0.00124,0.00110,2.65,2.30,-0.62,-0.55`;

describe('option chain ingestion and migration', () => {
  it('reads T-table implied volatility instead of the earlier historical-volatility column', () => {
    const tTable = `最后交易日,历史波动率,rho,theta,vega,gamma,delta,隐含波动率,中间价,MO2610 行权价 MO2610,中间价,隐含波动率,delta,gamma,vega,theta,rho,历史波动率,最后交易日
20261016,22.19%,0.12,-17.37,1.83,0.001836,0.318,38.04%,39.4,C 7000 P,136.4,38.56%,-0.678,0.001803,1.84,-17.49,-0.26,22.19%,20261016`;
    const preview = parseOptionChainText(tTable, { underlying: 'MO · 中证1000', expiry: '2026-10-16', multiplier: 100 });
    expect(preview.errors).toEqual([]);
    expect(preview.rows.find(c => c.optionType === 'CALL')?.impliedVolatility).toBeCloseTo(.3804);
    expect(preview.rows.find(c => c.optionType === 'PUT')?.impliedVolatility).toBeCloseTo(.3856);
  });

  it('previews all five call/put strikes with fast-futures raw Greek units', () => {
    const preview = parseOptionChainText(sample,{underlying:defaults.underlying,expiry:defaults.expiry,multiplier:defaults.multiplier});
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toHaveLength(10);
    const call = preview.rows.find(c=>c.strike===4300&&c.optionType==='CALL')!;
    const put = preview.rows.find(c=>c.strike===4300&&c.optionType==='PUT')!;
    expect(call.impliedVolatility).toBe(.2);
    expect(call.greeks.gamma).toBe(.00209);
    expect(call.greeks.vega).toBe(4.92);
    expect(put.greeks.gamma).toBe(.0022);
    expect(put.greeks.vega).toBe(4.8);
    expect(call.contractId).not.toBe(put.contractId);
  });

  it('keeps omitted Greeks and quotes missing instead of filling zero', () => {
    const preview=parseOptionChainText('strike,callPremium,putPremium\n4300,76.2,76.2',{underlying:defaults.underlying,expiry:defaults.expiry,multiplier:100});
    expect(preview.rows[0].greeks).toEqual({});
    expect(preview.rows[1].greeks).toEqual({});
    expect(preview.rows[0].impliedVolatility).toBeNull();
    expect(preview.errors).toEqual([]);
    const legs=legsFromChain(preview.rows,[{contractId:preview.rows[0].contractId,side:'LONG',quantity:1},{contractId:preview.rows[1].contractId,side:'SHORT',quantity:1}]);
    expect(legs).toHaveLength(2);
    expect(classifyStrategy(legs)?.name).toBe('CUSTOM STRATEGY');
    expect(analyzePayoff(legs).netDebit).toBeCloseTo(0);
  });

  it('migrates old legs into shared chain contracts and positions', () => {
    const oldLeg: OptionLeg={id:'old',optionType:'CALL',side:'LONG',strike:4300,premium:76.2,quantity:2,multiplier:100,expiry:'2026-12-24',iv:.2,greeks:{delta:.5}};
    const migrated=migrateWorkbenchState({...defaults,legs:[oldLeg,{...oldLeg,id:'old2',quantity:1}]},defaults);
    expect(migrated.optionChain).toHaveLength(1);
    expect(migrated.activeStrategy).toHaveLength(1);
    expect(migrated.activeStrategy[0].quantity).toBe(3);
    expect(legsFromChain(migrated.optionChain,migrated.activeStrategy)[0].premium).toBe(76.2);
  });

  it('builds both spread examples from the same chain and reflects quote edits immediately', () => {
    const parsed=parseOptionChainText(sample,{underlying:defaults.underlying,expiry:defaults.expiry,multiplier:100});
    const call4300=parsed.rows.find(c=>c.strike===4300&&c.optionType==='CALL')!;
    const call4400=parsed.rows.find(c=>c.strike===4400&&c.optionType==='CALL')!;
    const longCall={contractId:call4300.contractId,side:'LONG' as const,quantity:1};
    const shortCall={contractId:call4400.contractId,side:'SHORT' as const,quantity:1};
    const callLegs=legsFromChain(parsed.rows,[longCall,shortCall]);
    expect(classifyStrategy(callLegs)?.name).toBe('BULL CALL SPREAD');
    expect(analyzePayoff(callLegs).netDebit).toBeCloseTo((76.2-32.8)*100);
    const edited=parsed.rows.map(c=>c.contractId===call4300.contractId?{...c,premium:80,greeks:{...c.greeks,delta:.55}}:c);
    expect(legsFromChain(edited,[longCall,shortCall])[0].premium).toBe(80);
    expect(legsFromChain(edited,[longCall,shortCall])[0].greeks.delta).toBe(.55);
    const put4300=parsed.rows.find(c=>c.strike===4300&&c.optionType==='PUT')!;
    const put4200=parsed.rows.find(c=>c.strike===4200&&c.optionType==='PUT')!;
    const putLegs=legsFromChain(parsed.rows,[{contractId:put4300.contractId,side:'LONG',quantity:1},{contractId:put4200.contractId,side:'SHORT',quantity:1}]);
    expect(classifyStrategy(putLegs)?.name).toBe('BEAR PUT SPREAD');
    expect(parsed.rows).toHaveLength(10);
  });
});
