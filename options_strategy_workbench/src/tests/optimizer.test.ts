import { describe, expect, it, vi } from 'vitest';
import type { OptionContract, WorkbenchState } from '../models/option';
import * as pricing from '../engine/pricing';
import { grossExpirationPnl } from '../engine/payoff';
import { scenarioPnl } from '../engine/scenario';
import { defaultSettings, enumerateStructures, evaluateCandidate, greekRiskSummary, loadCandidate, prepareOptimization, rankCandidates, robustness, sampleProbabilities, shiftProbability, validateProbabilities, type OptimizerSettings } from '../engine/optimizer';
import { parseOptionChainText } from '../utils/optionChain';

const makeState=():WorkbenchState=>{
  const spot=4300,expiry='2026-10-30',valuationDate='2026-10-14',strikes=[4100,4200,4300,4400,4500];
  const optionChain:OptionContract[]=strikes.flatMap(strike=>(['CALL','PUT'] as const).map(optionType=>{
    const value=pricing.priceOption({optionType,strike,iv:.25},{spot,rate:1.65,dividend:2.3,days:16}).value;
    return {contractId:`IO2610-${optionType==='CALL'?'C':'P'}-${strike}`,underlying:'IO · 沪深300',optionType,strike,expiry,multiplier:100,
      premium:value,marketPremium:value,settlementPrice:value,bid:Math.max(0,value-.05),ask:value+.05,last:value,volume:100,openInterest:100,quoteStatus:'OK',impliedVolatility:.25,greeks:{}};
  }));
  return {underlying:'IO · 沪深300',valuationDate,spot,expiry,multiplier:100,daysToExpiry:16,riskFreeRate:1.65,dividendYield:2.3,costs:{openPerContract:1,closePerContract:1,settlementPerContract:1},marginParams:{m:.12,minimumRatio:.5},optionChain,activeStrategy:[],savedStrategies:[]};
};
const getSettings=(state=makeState()):OptimizerSettings=>{
  const settings=defaultSettings(state);settings.widthMin=100;settings.widthMax=200;settings.shortAtmMax=500;
  settings.limits.maxLoss.enabled=false;settings.limits.maxMargin.enabled=false;settings.limits.maxScenarioLoss.enabled=false;
  return settings;
};
const candidates=(state=makeState(),settings=getSettings(state))=>{
  const prepared=prepareOptimization(state,settings);
  return [...enumerateStructures(prepared)].flatMap(p=>{const c=evaluateCandidate(prepared,p);return c?[c]:[];});
};

describe('Strike Optimizer',()=>{
  it('orders Bear Call short lower / long higher and uses real contract codes',()=>{
    const state=makeState(),settings=getSettings(state),prepared=prepareOptimization(state,settings);
    const structures=[...enumerateStructures(prepared)];expect(structures.length).toBeGreaterThan(0);
    for(const p of structures){expect(p[0].side).toBe('SHORT');expect(p[1].side).toBe('LONG');expect(p[0].contract.strike).toBeLessThan(p[1].contract.strike);expect(state.optionChain).toContain(p[0].contract);}
  });
  it('orders Bear Put long lower / short higher',()=>{
    const state=makeState(),settings={...getSettings(state),strategy:'BEAR_PUT' as const};
    for(const p of enumerateStructures(prepareOptimization(state,settings))){expect(p.map(x=>x.side)).toEqual(['LONG','SHORT']);expect(p[0].contract.strike).toBeLessThan(p[1].contract.strike);}
  });
  it('enumerates asymmetric iron condors with four distinct ordered strikes',()=>{
    const state=makeState(),settings={...getSettings(state),strategy:'IRON_CONDOR' as const};
    const rows=[...enumerateStructures(prepareOptimization(state,settings))];expect(rows.length).toBeGreaterThan(0);
    for(const row of rows){expect(row.map(x=>x.side)).toEqual(['LONG','SHORT','SHORT','LONG']);expect(row.every((x,i)=>i===0||x.contract.strike>row[i-1].contract.strike)).toBe(true);}
    expect(rows.some(r=>r[1].contract.strike-r[0].contract.strike!==r[3].contract.strike-r[2].contract.strike)).toBe(true);
  });
  it('iron butterfly shares the two short strikes and filters unequal wings when requested',()=>{
    const state=makeState(),settings={...getSettings(state),strategy:'IRON_BUTTERFLY' as const,asymmetric:false};
    const rows=[...enumerateStructures(prepareOptimization(state,settings))];expect(rows.length).toBeGreaterThan(0);
    for(const row of rows){expect(row[1].contract.strike).toBe(row[2].contract.strike);expect(row[1].contract.strike-row[0].contract.strike).toBe(row[3].contract.strike-row[2].contract.strike);}
  });
  it('makes entry PnL zero by accounting identity and expiry value equals payoff',()=>{
    const c=candidates()[0];expect(c).toBeDefined();
    expect(c.entryPnl).toBe(0);
    const spot=4200,expected=grossExpirationPnl(c.legs,spot);
    expect(scenarioPnl(c.legs,{spot,valuationDate:'2026-10-14',daysForward:16,ivShift:0,rate:1.65,dividend:2.3})).toBeCloseTo(expected,6);
  });
  it('keeps BSM PnL inside finite payoff bounds without clipping',()=>{
    const rows=candidates();expect(rows.length).toBeGreaterThan(0);
    for(const c of rows){expect(c.maxProfit).not.toBe('UNLIMITED');expect(c.maxLoss).not.toBe('UNLIMITED');for(const pnl of c.scenarioPnls){expect(pnl).toBeLessThanOrEqual(c.maxProfit as number+.1);expect(pnl).toBeGreaterThanOrEqual(-(c.maxLoss as number)-.1);}}
  });
  it('keeps iron condor scenario PnL inside its asymmetric payoff bounds',()=>{
    const state=makeState(),settings={...getSettings(state),strategy:'IRON_CONDOR' as const};
    const rows=candidates(state,settings);expect(rows.length).toBeGreaterThan(0);
    for(const c of rows){expect(c.maxProfit).not.toBe('UNLIMITED');expect(c.maxLoss).not.toBe('UNLIMITED');for(const pnl of c.scenarioPnls){expect(pnl).toBeLessThanOrEqual(c.maxProfit as number+.1);expect(pnl).toBeGreaterThanOrEqual(-(c.maxLoss as number)-.1);}}
  });
  it('rejects a cross-strike arbitrage surface instead of clipping a gain',()=>{
    const state=makeState(),settings=getSettings(state),prep=prepareOptimization(state,settings);
    const p=[...enumerateStructures(prep)].find(x=>x[0].contract.strike===4200&&x[1].contract.strike===4400)!;
    const marks=prep.marks.get(p[1].contract.contractId)!;marks[0]={...marks[0],value:marks[0].value+500};
    expect(evaluateCandidate(prep,p)).toBeNull();expect(prep.counts.reasons['跨执行价 BSM 曲面异常']).toBe(1);
  });
  it('rejects an executable credit wider than the spread width',()=>{
    const state=makeState(),c=state.optionChain.find(x=>x.optionType==='CALL'&&x.strike===4300)!;
    c.bid=300;c.ask=300.1;
    const settings=getSettings(state),prep=prepareOptimization(state,settings);
    const p=[...enumerateStructures(prep)].find(x=>x[0].contract.strike===4300&&x[1].contract.strike===4400)!;
    expect(evaluateCandidate(prep,p)).toBeNull();expect(prep.counts.reasons['建仓报价套利异常']).toBe(1);
  });
  it('rejects a probability sum other than 100% and leaves manual input unchanged',()=>{
    const s=getSettings(makeState()).scenarios;s[0].probability=31;
    expect(validateProbabilities(s)).toMatch(/须等于 100/);expect(s.reduce((a,b)=>a+b.probability,0)).toBe(101);
  });
  it('adjusts one probability, preserving locked weights and the simplex',()=>{
    const s=getSettings(makeState()).scenarios;const next=shiftProbability(s,1,20,new Set([s[0].id]))!;
    expect(next[0].probability).toBe(30);expect(next[1].probability).toBe(20);expect(next.reduce((a,b)=>a+b.probability,0)).toBeCloseTo(100,8);
  });
  it('re-ranks on probability change without calling BSM again',()=>{
    const state=makeState(),settings=getSettings(state),rows=candidates(state,settings),spy=vi.spyOn(pricing,'priceOption');
    const before=rankCandidates(rows,settings.scenarios);const shifted=shiftProbability(settings.scenarios,1,30)!;const after=rankCandidates(rows,shifted);
    expect(spy).not.toHaveBeenCalled();expect(before.length).toBe(after.length);expect(after[0].expected).not.toBe(before[0].expected);spy.mockRestore();
  });
  it('uses the same scenario vector for every candidate',()=>{
    const state=makeState(),settings=getSettings(state),rows=candidates(state,settings);
    expect(rows.length).toBeGreaterThan(1);expect(rows.every(c=>c.scenarioPnls.length===settings.scenarios.length&&c.scenarioGreeks.length===settings.scenarios.length)).toBe(true);
  });
  it('samples only valid bounded probability vectors and reproduces robustness with a seed',()=>{
    const state=makeState(),settings=getSettings(state),rows=candidates(state,settings);
    const vectors=sampleProbabilities(settings.scenarios,10,100,77);
    for(const p of vectors){expect(p.reduce((a,b)=>a+b,0)).toBeCloseTo(1,10);p.forEach((v,i)=>{expect(v).toBeGreaterThanOrEqual(-1e-10);expect(Math.abs(v-settings.scenarios[i].probability/100)).toBeLessThanOrEqual(.10000001);});}
    expect(robustness(rows,settings.scenarios,10,100,77)).toEqual(robustness(rows,settings.scenarios,10,100,77));
  });
  it('detects Greek sign reversal and maximum scenario exposure',()=>{
    const g={delta:-10,gamma:-2,vega:3,theta:1,rho:0};const summary=greekRiskSummary(g,[{delta:5,gamma:-1,vega:2,theta:-4,rho:0},{delta:-20,gamma:2,vega:1,theta:3,rho:0}]);
    expect(summary.reversals).toBe(2);expect(summary.maxAbs.delta).toBe(20);expect(summary.maxAbs.theta).toBe(4);
  });
  it('excludes missing Bid/Ask in executable mode and labels Mid separately',()=>{
    const state=makeState(),settings=getSettings(state);state.optionChain.find(c=>c.optionType==='CALL'&&c.strike===4300)!.ask=null;
    const prep=prepareOptimization(state,settings),row=[...enumerateStructures(prep)].find(x=>x[0].contract.strike===4300)!;
    expect(evaluateCandidate(prep,row)).toBeNull();expect(prep.counts.reasons['报价 / 流动性不足']).toBe(1);
    settings.entryMode='MID';settings.limits.maxSpread.enabled=false;expect(evaluateCandidate(prepareOptimization(state,settings),row)).not.toBeNull();
  });
  it('does not overwrite saved strategies when loading a candidate for comparison',()=>{
    const state=makeState(),settings=getSettings(state),row=candidates(state,settings)[0];
    state.savedStrategies=[{id:'existing',name:'Existing',underlying:state.underlying,createdAt:'2026-10-01',updatedAt:'2026-10-01',legs:[],pricingSettings:{spot:state.spot,expiry:state.expiry,riskFreeRate:state.riskFreeRate,dividendYield:state.dividendYield,multiplier:state.multiplier},transactionCosts:state.costs,notes:''}];
    const loaded=loadCandidate(state,row,settings,false);expect(loaded.activeStrategy.map(x=>x.entryPremium)).toEqual(row.legs.map(x=>x.premium));
    const compared=loadCandidate(state,row,settings,true);expect(compared.savedStrategies?.map(x=>x.id)).toContain('existing');expect(compared.savedStrategies).toHaveLength(2);expect(compared.activeStrategy).toEqual(state.activeStrategy);
  });
  it('reapplies risk limits before ranking',()=>{
    const state=makeState(),settings=getSettings(state),prep=prepareOptimization(state,settings),p=[...enumerateStructures(prep)][0];
    expect(evaluateCandidate(prep,p)).not.toBeNull();settings.limits.maxLoss={enabled:true,value:1};
    expect(evaluateCandidate(prepareOptimization(state,settings),p)).toBeNull();
  });
  it('imports real IDs and separate Bid, Ask, Last, Mid, volume, and OI',()=>{
    const csv='tradeDate,underlying,expiry,spot,riskFreeRate,strike,callContractId,callBid,callAsk,callMid,callLast,callVolume,callOpenInterest,callQuoteStatus,callIV,putContractId,putBid,putAsk,putMid,putIV\n2026-10-14,IO · 沪深300,2026-10-30,4300,1.65,4300,IO2610-C-4300,75,76,75.5,75.4,100,200,OK,25,IO2610-P-4300,74,75,74.5,25';
    const parsed=parseOptionChainText(csv,{underlying:'IO · 沪深300',expiry:'2026-10-30',multiplier:100});
    expect(parsed.errors).toEqual([]);expect(parsed.rows[0].contractId).toBe('IO2610-C-4300');expect(parsed.rows[0].bid).toBe(75);expect(parsed.rows[0].ask).toBe(76);expect(parsed.rows[0].last).toBe(75.4);expect(parsed.rows[0].marketPremium).toBe(75.5);expect(parsed.rows[0].volume).toBe(100);expect(parsed.rows[0].openInterest).toBe(200);expect(parsed.spot).toBe(4300);
  });
  it('prefers the quoted real contract over an older synthetic row at the same strike',()=>{
    const state=makeState(),original=state.optionChain.find(c=>c.optionType==='CALL'&&c.strike===4300)!;
    state.optionChain.unshift({...original,contractId:JSON.stringify([state.underlying,state.expiry,'CALL',4300]),bid:null,ask:null,volume:null});
    const prepared=prepareOptimization(state,getSettings(state));
    expect(prepared.contracts.filter(c=>c.optionType==='CALL'&&c.strike===4300)).toEqual([original]);
  });
  it('requires real contract codes for executable ranking but permits marked theoretical study',()=>{
    const state=makeState(),contract=state.optionChain.find(c=>c.optionType==='CALL'&&c.strike===4300)!;
    contract.contractId=JSON.stringify([state.underlying,state.expiry,'CALL',4300]);
    const settings=getSettings(state),prep=prepareOptimization(state,settings),row=[...enumerateStructures(prep)].find(p=>p[0].contract.strike===4300)!;
    expect(evaluateCandidate(prep,row)).toBeNull();expect(prep.counts.reasons['缺少真实合约代码']).toBe(1);
    settings.entryMode='MID';expect(evaluateCandidate(prepareOptimization(state,settings),row)).not.toBeNull();
  });
});
