import { describe, expect, it, vi } from 'vitest';
import type { OptionContract, WorkbenchState } from '../models/option';
import * as pricing from '../engine/pricing';
import { grossExpirationPnl } from '../engine/payoff';
import { scenarioPnl } from '../engine/scenario';
import { assessQuoteQuality, defaultSettings, enumerateStructures, evaluateCandidate, expirationScenarioPnls, greekRiskSummary, loadCandidate, migrateGreekLimits, prepareOptimization, rankCandidates, robustness, sampleProbabilities, shiftProbability, validateProbabilities, type OptimizerSettings } from '../engine/optimizer';
import { shortOptionMargin } from '../engine/margin';
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
  it('reproduces SC6200/LC6300 expiry loss, BSM T+1 marks, margin basis, and quality rejection',()=>{
    const spot=6905.17,expiry='2026-10-16',valuationDate='2026-10-14',underlying='MO · 中证1000';
    const state={...makeState(),spot,expiry,valuationDate,underlying,dividendYield:1.1,riskFreeRate:1.66,costs:{openPerContract:0,closePerContract:0,settlementPerContract:0},optionChain:[
      {contractId:'MO2610-C-6200',underlying,optionType:'CALL' as const,strike:6200,expiry,multiplier:100,premium:703.2,marketPremium:703.2,settlementPrice:703.2,impliedVolatility:.9202,greeks:{}},
      {contractId:'MO2610-C-6300',underlying,optionType:'CALL' as const,strike:6300,expiry,multiplier:100,premium:603.8,marketPremium:603.8,settlementPrice:603.8,impliedVolatility:1.1257,greeks:{}},
    ]};
    const settings=defaultSettings(state);settings.entryMode='MID';settings.bearCallAtmFilter=false;
    for(const item of Object.values(settings.limits))item.enabled=false;
    const prepared=prepareOptimization(state,settings),positions=[...enumerateStructures(prepared)][0];
    expect(positions.map(p=>p.contract.strike)).toEqual([6200,6300]);
    const legs=positions.map(p=>({id:p.contract.contractId,optionType:p.contract.optionType,side:p.side,strike:p.contract.strike,premium:p.contract.premium!,quantity:1,multiplier:100,expiry,iv:p.contract.impliedVolatility!,greeks:{}}));
    for(const pnl of expirationScenarioPnls(legs,settings.scenarios,spot))expect(pnl).toBeCloseTo(-60,8);
    for(const [i,scenario] of settings.scenarios.entries()){
      const shiftedSpot=spot*(1+scenario.movePct/100),days=2-scenario.days;
      const direct=legs.reduce((sum,leg)=>sum+(leg.side==='LONG'?1:-1)*(pricing.priceOption({...leg,iv:leg.iv+scenario.ivPp/100},{spot:shiftedSpot,days,rate:1.66,dividend:1.1}).value-leg.premium)*100,0);
      const cached=positions.reduce((sum,p)=>sum+(p.side==='LONG'?1:-1)*(prepared.marks.get(p.contract.contractId)![i].value-p.contract.premium!)*100,0);
      expect(cached).toBeCloseTo(direct,8);
    }
    expect(shortOptionMargin({optionType:'CALL',spot,strike:6200,settlementPrice:703.2,multiplier:100,params:{m:.12,minimumRatio:.5}})).toBeCloseTo(153182.04,2);
    expect(assessQuoteQuality(positions,state,settings,2).issues).toContain('MO2610-C-6200：行情价格低于 BSM 欧式下界');
    expect(evaluateCandidate(prepared,positions)).toBeNull();
    const defaultPositions=[...enumerateStructures(prepareOptimization(state,defaultSettings(state)))];
    expect(defaultPositions).toHaveLength(0);
  });
  it('ranks by expected PnL by default, not a tiny max-loss denominator, and updates after probability changes',()=>{
    const settings=getSettings(),base=candidates()[0],a={...base,id:'small-loss',scenarioPnls:[100,0,0,0,0,0],marketMidScenarioPnls:[100,0,0,0,0,0],expiryScenarioPnls:[-1,-1,-1,-1,-1,-1],scenarioPnlGaps:[101,1,1,1,1,1],maxLoss:1},b={...base,id:'higher-pnl',scenarioPnls:[0,100,100,100,100,100],marketMidScenarioPnls:[0,100,100,100,100,100],expiryScenarioPnls:[10,10,10,10,10,10],scenarioPnlGaps:[-10,90,90,90,90,90],maxLoss:100};
    expect(rankCandidates([a,b],settings.scenarios)[0].id).toBe('higher-pnl');
    expect(rankCandidates([a,b],settings.scenarios,'EXPECTED_LOSS')[0].id).toBe('small-loss');
    const changed=shiftProbability(settings.scenarios,0,90)!;
    const reranked=rankCandidates([a,b],changed);
    expect(reranked[0].id).toBe('small-loss');
    expect(reranked[0].expiryProfitableWeight).toBe(0);
  });
  it('ranks with the selected model or market Mid PnL basis',()=>{
    const settings=getSettings(),base=candidates()[0];
    const modelWinner={...base,id:'model',scenarioPnls:[-50,-50,-50,-50,-50,-50],modelScenarioPnls:[20,20,20,20,20,20],marketMidScenarioPnls:[-10,-10,-10,-10,-10,-10]};
    const marketWinner={...base,id:'market',scenarioPnls:[-20,-20,-20,-20,-20,-20],modelScenarioPnls:[-5,-5,-5,-5,-5,-5],marketMidScenarioPnls:[30,30,30,30,30,30]};
    expect(rankCandidates([modelWinner,marketWinner],settings.scenarios,'EXPECTED','MODEL')[0].id).toBe('model');
    expect(rankCandidates([modelWinner,marketWinner],settings.scenarios,'EXPECTED','MARKET')[0].id).toBe('market');
  });
  it('does not invent a fixed q when the chain has no q and no manual override',()=>{
    const state={...makeState(),dividendYieldSource:'UNSET' as const,optionChain:makeState().optionChain.map(c=>({...c,dividendYield:undefined}))};
    const settings=getSettings(state),prepared=prepareOptimization(state,settings),positions=[...enumerateStructures(prepared)][0];
    expect(positions).toBeDefined();
    expect(assessQuoteQuality(positions,state,settings,16).status).toBe('REJECT');
    expect(evaluateCandidate(prepared,positions)).toBeNull();
  });
  it('checks market monotonicity, vertical bounds, IV validity and quote synchronization',()=>{
    const state=makeState(),settings=getSettings(state),prep=prepareOptimization(state,settings),pair=[...enumerateStructures(prep)].find(p=>p[0].contract.strike===4300&&p[1].contract.strike===4400)!;
    expect(assessQuoteQuality(pair,state,settings,16).status).toBe('WARNING');
    const low=pair[0].contract,high=pair[1].contract,oldLow=low.marketPremium,oldHigh=high.marketPremium;
    low.marketPremium=1;high.marketPremium=10;
    expect(assessQuoteQuality(pair,state,settings,16).issues.some(x=>x.includes('未随执行价单调'))).toBe(true);
    low.marketPremium=200;high.marketPremium=1;
    expect(assessQuoteQuality(pair,state,settings,16).issues.some(x=>x.includes('无套利上界'))).toBe(true);
    low.marketPremium=oldLow;high.marketPremium=oldHigh;high.impliedVolatility=null;
    expect(assessQuoteQuality(pair,state,settings,16).issues.some(x=>x.includes('IV 无效'))).toBe(true);
    high.impliedVolatility=.25;
    low.quoteAt='2026-10-14T15:00:00+08:00';high.quoteAt=low.quoteAt;
    low.ivAt='2026-10-14';high.ivAt='2026-10-14';
    const dateOnlyQuality=assessQuoteQuality(pair,state,settings,16);
    expect(dateOnlyQuality.status).toBe('WARNING');
    expect(dateOnlyQuality.issues.some(x=>x.includes('相差超过 5 分钟'))).toBe(false);
    high.ivAt='2026-10-13';
    expect(assessQuoteQuality(pair,state,settings,16).issues.some(x=>x.includes('IV 与行情日期不同'))).toBe(true);
    low.quoteAt='2026-10-14T15:00:00+08:00';high.quoteAt='2026-10-14T15:10:00+08:00';
    low.ivAt=low.quoteAt;high.ivAt=high.quoteAt;
    expect(assessQuoteQuality(pair,state,settings,16).issues).toContain('逐腿行情时间相差超过 5 分钟');
    high.quoteAt=low.quoteAt;high.ivAt='2026-10-14T14:50:00+08:00';
    expect(assessQuoteQuality(pair,state,settings,16).issues.some(x=>x.includes('IV 与报价时间'))).toBe(true);
  });
  it('makes Greek direction filters optional',()=>{
    const state=makeState(),settings=getSettings(state),candidate=candidates(state,settings).find(c=>c.baseGreeks.delta>=0||c.baseGreeks.vega>=0||c.baseGreeks.theta<=0);
    expect(candidate).toBeDefined();
    settings.greekPreferences.negativeDelta=true;settings.greekPreferences.negativeVega=true;settings.greekPreferences.positiveTheta=true;
    expect(evaluateCandidate(prepareOptimization(state,settings),candidate!.positions)).toBeNull();
  });
  it('uses the main workbench Greek units at entry and after a BSM scenario repricing',()=>{
    const state=makeState(),settings=getSettings(state),candidate=candidates(state,settings)[0];
    expect(candidate).toBeDefined();
    const sum=(days:number,spot:number,ivShift:number)=>pricing.aggregateGreeks(candidate.legs.map(leg=>pricing.legGreeks({...leg,iv:leg.iv+ivShift},{spot,days,rate:state.riskFreeRate,dividend:state.dividendYield})));
    const initial=sum(16,state.spot,0),scenario=settings.scenarios[0],shifted=sum(16-scenario.days,state.spot*(1+scenario.movePct/100),scenario.ivPp/100);
    for(const key of ['delta','gamma','theta','vega','rho'] as const){
      expect(candidate.baseGreeks[key]).toBeCloseTo(initial[key]!,8);
      expect(candidate.scenarioGreeks[0]![key]).toBeCloseTo(shifted[key]!,8);
    }
  });
  it('migrates old cash Greek risk thresholds once',()=>{
    const old=defaultSettings(makeState()).limits;old.maxDelta={enabled:true,value:100};old.maxGamma={enabled:true,value:1};old.maxVega={enabled:true,value:200};
    const migrated=migrateGreekLimits(old,100,false);
    expect([migrated.maxDelta.value,migrated.maxGamma.value,migrated.maxVega.value]).toEqual([1,.01,2]);
    expect(migrateGreekLimits(migrated,100,true)).toBe(migrated);
  });
  it('applies the Delta budget in the same raw units shown on screen',()=>{
    const state=makeState(),settings=getSettings(state),prepared=prepareOptimization(state,settings);
    const positions=[...enumerateStructures(prepared)][0],candidate=evaluateCandidate(prepared,positions)!;
    expect(Math.abs(candidate.baseGreeks.delta)).toBeGreaterThan(0);
    settings.limits.maxDelta={enabled:true,value:Math.abs(candidate.baseGreeks.delta)/2};
    expect(evaluateCandidate(prepareOptimization(state,settings),positions)).toBeNull();
  });
  it('orders all vertical spreads by the correct directional payoff',()=>{
    const state=makeState();
    const orientations={BULL_CALL:['LONG','SHORT'],BEAR_CALL:['SHORT','LONG'],BULL_PUT:['LONG','SHORT'],BEAR_PUT:['SHORT','LONG']} as const;
    for(const [strategy,sides] of Object.entries(orientations)){
      const settings={...getSettings(state),strategy:strategy as OptimizerSettings['strategy']};
      const structures=[...enumerateStructures(prepareOptimization(state,settings))];expect(structures.length).toBeGreaterThan(0);
      for(const p of structures){
        expect(p.map(x=>x.side)).toEqual(sides);
        expect(p[0].contract.strike).toBeLessThan(p[1].contract.strike);
        expect(p[0].contract.optionType).toBe(strategy.endsWith('CALL')?'CALL':'PUT');
        expect(state.optionChain).toContain(p[0].contract);
      }
    }
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
    const spot=4200,expected=grossExpirationPnl(c.legs.map(l=>({...l,premium:l.marketEntryPremium??l.premium})),spot);
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
  it('excludes an actual pair of leg IVs when a shock makes its BSM call curve nonmonotone',()=>{
    const state=makeState(),settings=getSettings(state);
    for(const [strike,iv] of [[4200,.1],[4300,.2]]){
      const c=state.optionChain.find(x=>x.optionType==='CALL'&&x.strike===strike)!;
      const price=pricing.priceOption({optionType:'CALL',strike,iv},{spot:state.spot,days:16,rate:state.riskFreeRate,dividend:state.dividendYield}).value;
      c.impliedVolatility=iv;c.premium=price;c.marketPremium=price;c.settlementPrice=price;c.bid=price-.01;c.ask=price+.01;
    }
    const prep=prepareOptimization(state,settings),pair=[...enumerateStructures(prep)].find(p=>p[0].contract.strike===4200&&p[1].contract.strike===4300)!;
    expect(assessQuoteQuality(pair,state,settings,16).status).not.toBe('REJECT');
    expect(evaluateCandidate(prep,pair)).toBeNull();
    expect(prep.counts.reasons['跨执行价 BSM 曲面异常']).toBe(1);
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
