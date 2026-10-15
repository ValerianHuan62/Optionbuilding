import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionLeg, WorkbenchState } from '../models/option';
import { shortOptionMargin, marginForContract } from '../engine/margin';
import { normalizeGreeks } from '../engine/greeks';
import { priceOption } from '../engine/pricing';
import { scenarioPnl } from '../engine/scenario';
import { calculateScenarioGrid, commonPriceGrid, hasCommonExpiry } from '../engine/scenarioGrid';
import { legsFromChain, migrateWorkbenchState } from '../utils/optionChain';

const params={m:.12,minimumRatio:.5};
const defaults:WorkbenchState={underlying:'MO · 中证1000',spot:6970,forward:6970,expiry:'2026-12-24',daysToExpiry:10,multiplier:100,model:'BSM',riskFreeRate:1.65,dividendYield:0,greeksMode:'MANUAL',greekInputFormat:'LEGACY_POINTS',marginParams:params,costs:{openPerContract:0,closePerContract:0,settlementPerContract:0},optionChain:[],activeStrategy:[]};
const contract=(o:Partial<OptionContract>={}):OptionContract=>({contractId:'MO-C-7000',underlying:'MO · 中证1000',optionType:'CALL',strike:7000,expiry:'2026-12-24',multiplier:100,premium:70.2,settlementPrice:null,impliedVolatility:.25,greeks:{},...o});
const leg=(o:Partial<OptionLeg>={}):OptionLeg=>({id:'leg-1',optionType:'CALL',side:'LONG',strike:100,premium:10,quantity:1,multiplier:100,expiry:'2026-12-24',iv:.25,greeks:{},...o});
const scenario=(input:Partial<Parameters<typeof scenarioPnl>[1]>={})=>({spot:100,forward:100,valuationDate:'2026-10-14',daysToExpiryByLeg:{'leg-1':10},daysForward:0,ivShift:0,rate:0,dividend:0,model:'BSM' as const,openFees:0,closePerContract:0,settlementPerContract:0,...input});

describe('V3 entry price, library migration, and chain isolation',()=>{
  it('keeps saved contract identity and entry premiums separate from editable market premiums',()=>{
    const chain=[contract({premium:76.2})];
    const snapshot:WorkbenchState={...defaults,optionChain:chain,activeStrategy:[{contractId:chain[0].contractId,side:'LONG',quantity:2,entryPremium:76.2}]};
    const restored=migrateWorkbenchState(JSON.parse(JSON.stringify(snapshot)),defaults);
    const marketUpdate=restored.optionChain.map(c=>({...c,premium:81.5}));
    expect(legsFromChain(marketUpdate,restored.activeStrategy)[0].premium).toBe(76.2);
    expect(marketUpdate[0].premium).toBe(81.5);
    expect(restored.activeStrategy[0].quantity).toBe(2);
  });
  it('captures a legacy position entry price on migration',()=>{
    const chain=[contract({premium:76.2})];
    const migrated=migrateWorkbenchState({...defaults,optionChain:chain,activeStrategy:[{contractId:chain[0].contractId,side:'SHORT',quantity:1}]},defaults);
    expect(migrated.activeStrategy[0].entryPremium).toBe(76.2);
  });
  it('round-trips two separately saved strategies without mutating the shared chain',()=>{
    const c=contract({premium:76.2});
    const saved=[{id:'a',name:'Bull Call',underlying:c.underlying,createdAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z',legs:[{contractId:c.contractId,side:'LONG' as const,quantity:1,entryPremium:76.2}],pricingSettings:{spot:6970,forward:6970,expiry:c.expiry,model:'BSM' as const,riskFreeRate:1.65,dividendYield:0,multiplier:100,greeksMode:'MANUAL' as const},transactionCosts:defaults.costs,notes:''},
      {id:'b',name:'Short Call',underlying:c.underlying,createdAt:'2026-10-14T00:00:01Z',updatedAt:'2026-10-14T00:00:01Z',legs:[{contractId:c.contractId,side:'SHORT' as const,quantity:2,entryPremium:80}],pricingSettings:{spot:6970,forward:6970,expiry:c.expiry,model:'BSM' as const,riskFreeRate:1.65,dividendYield:0,multiplier:100,greeksMode:'MANUAL' as const},transactionCosts:defaults.costs,notes:''}];
    const restored=migrateWorkbenchState(JSON.parse(JSON.stringify({...defaults,optionChain:[c],savedStrategies:saved})),defaults);
    expect(restored.savedStrategies?.map(x=>x.name)).toEqual(['Bull Call','Short Call']);
    expect(restored.optionChain[0].premium).toBe(76.2);
    expect(restored.savedStrategies?.[1].legs[0].entryPremium).toBe(80);
  });
});

describe('CFFEX short-option margin assumptions',()=>{
  it('matches the Short Call acceptance example: 87,660 CNY',()=>{
    expect(shortOptionMargin({optionType:'CALL',spot:6970,strike:7000,settlementPrice:70.2,multiplier:100,params})).toBe(87660);
  });
  it('matches the Short Put acceptance example: 93,380 CNY',()=>{
    expect(shortOptionMargin({optionType:'PUT',spot:6970,strike:7000,settlementPrice:97.4,multiplier:100,params})).toBe(93380);
  });
  it('uses market premium only as an explicitly estimated fallback',()=>{
    const row=marginForContract(contract(),{side:'SHORT',quantity:1},6970,params);
    expect(row?.priceSource).toBe('ESTIMATED_MARKET');
    expect(row?.amount).toBe(87660);
    expect(marginForContract(contract({settlementPrice:70.2}),{side:'SHORT',quantity:1},6970,params)?.priceSource).toBe('SETTLEMENT');
  });
});

describe('Greek source unit profiles',()=>{
  it('keeps fast-futures raw point units without applying the contract multiplier',()=>{
    const result=normalizeGreeks({delta:.4531,gamma:.00113,theta:-1.04,vega:3.28,rho:2.5},100,'KUAIQI_RAW');
    expect(result.delta).toBeCloseTo(.4531,8); expect(result.gamma).toBeCloseTo(.00113,8);
    expect(result.theta).toBe(-1.04); expect(result.vega).toBe(3.28); expect(result.rho).toBe(2.5);
  });
  it('migrates saved legacy Greeks into the new fixed raw-point input units',()=>{
    const chain=[contract({greeks:{delta:.5,gamma:.002,theta:-1.2,vega:450,rho:200,source:'LEGACY_POINTS'}})];
    const migrated=migrateWorkbenchState({...defaults,optionChain:chain},defaults);
    expect(migrated.greekInputFormat).toBe('KUAIQI_RAW');
    expect(migrated.optionChain[0].greeks).toMatchObject({delta:.5,gamma:.002,theta:-1.2,vega:4.5,rho:2,source:'KUAIQI_RAW'});
    expect(normalizeGreeks(migrated.optionChain[0].greeks,100,migrated.greekInputFormat)).toMatchObject({delta:.5,gamma:.002,theta:-1.2,vega:4.5,rho:2});
  });
  it('repairs the first unversioned quick-unit snapshot without rescaling Vega or Rho',()=>{
    const chain=[contract({greeks:{delta:.00509,gamma:.0000209,theta:-.0127,vega:4.92,rho:2,source:'KUAIQI_RAW'}})];
    const migrated=migrateWorkbenchState({...defaults,greekInputFormat:'KUAIQI_RAW',optionChain:chain},defaults);
    expect(migrated.optionChain[0].greeks).toMatchObject({delta:.509,gamma:.00209,theta:-1.27,vega:4.92,rho:2,source:'KUAIQI_RAW'});
    expect(migrated.greekUnitsVersion).toBe(1);
  });
  it('normalizes yearly and decimal raw Greeks to point units',()=>{
    const result=normalizeGreeks({delta:.4531,theta:-5123.2955,vega:251.0965,rho:26.6675},100,'TONGHUASHUN_RAW',{thetaUnit:'YEAR',vegaUnit:'IV_DECIMAL',rhoUnit:'RATE_DECIMAL',includesMultiplier:false});
    expect(result.delta).toBeCloseTo(.4531,8);
    expect(result.theta).toBeCloseTo(-5123.2955/365,8);
    expect(result.vega).toBeCloseTo(2.510965,8);
    expect(result.rho).toBeCloseTo(.266675,8);
  });
  it('converts standardized single-contract CNY values back to point units once',()=>{
    const result=normalizeGreeks({delta:45.31,vega:251.0965},100,'STANDARDIZED');
    expect(result.delta).toBeCloseTo(.4531,8);
    expect(result.vega).toBeCloseTo(2.510965,8);
  });
});

describe('revalued scenario PnL',()=>{
  it('reprices the reported MO bear call spread with T0=2/365 and T1=1/365',()=>{
    const short=leg({id:'short-7000',side:'SHORT',strike:7000,premium:39.4,iv:.3804,expiry:'2026-10-16'});
    const long=leg({id:'long-7200',strike:7200,premium:6.4,iv:.3885,expiry:'2026-10-16'});
    const spot=6905.17*.95;
    const input={spot,forward:spot,valuationDate:'2026-10-14',daysToExpiryByLeg:undefined,daysForward:1,ivShift:.08,rate:1.65,dividend:1.1,model:'BSM' as const};
    const shortMark=priceOption({...short,iv:.4604},{spot,forward:spot,rate:1.65,dividend:1.1,days:1,model:'BSM'}).value;
    const longMark=priceOption({...long,iv:.4685},{spot,forward:spot,rate:1.65,dividend:1.1,days:1,model:'BSM'}).value;
    const pnl=scenarioPnl([short,long],input);
    const todayPnl=scenarioPnl([short,long],{...input,daysForward:0});
    const shortToday=priceOption({...short,iv:.4604},{spot,forward:spot,rate:1.65,dividend:1.1,days:2,model:'BSM'}).value;
    const longToday=priceOption({...long,iv:.4685},{spot,forward:spot,rate:1.65,dividend:1.1,days:2,model:'BSM'}).value;
    expect(todayPnl).toBeCloseTo((33-shortToday+longToday)*100,6);
    expect(pnl).toBeCloseTo((33-shortMark+longMark)*100,6);
    expect(pnl).toBeGreaterThan(3200);
    expect(pnl).toBeLessThan(3300);
    expect(scenarioPnl([short,long],{...input,daysForward:2})).toBe(3300);
  });
  it('keeps BSM dividend carry and Black-76 forward carry consistent at the same horizon',()=>{
    const l=leg({strike:100,iv:.3,expiry:'2026-10-16'});
    const input=scenario({spot:102,forward:102*Math.exp((.02-.01)/365),valuationDate:'2026-10-14',daysToExpiryByLeg:undefined,daysForward:1,rate:2,dividend:1});
    expect(scenarioPnl([l],input)).toBeCloseTo(scenarioPnl([l],{...input,model:'BLACK76'})!,8);
  });
  it('rejects an inconsistent strike-IV surface instead of exceeding spread maximum profit',()=>{
    const short=leg({id:'short',side:'SHORT',strike:100,premium:10,iv:.05,expiry:'2026-10-16'});
    const long=leg({id:'long',strike:120,premium:1,iv:2,expiry:'2026-10-16'});
    expect(scenarioPnl([short,long],scenario({valuationDate:'2026-10-14',daysToExpiryByLeg:undefined,daysForward:1}))).toBeNull();
  });
  it('maps IV 25% + 3pp to 28%',()=>{
    const l=leg();
    const actual=scenarioPnl([l],scenario({ivShift:.03}))!;
    const expected=(priceOption(l,{spot:100,forward:100,rate:0,dividend:0,days:10,model:'BSM'}).value-l.premium)*100;
    const iv28=(priceOption({...l,iv:.28},{spot:100,forward:100,rate:0,dividend:0,days:10,model:'BSM'}).value-l.premium)*100;
    expect(actual).toBeCloseTo(iv28,8);
    expect(actual).not.toBeCloseTo(expected,4);
  });
  it('advances each leg from 10 calendar days to 7 and recomputes theoretical PnL at zero scenario shift',()=>{
    const l=leg({premium:8});
    const actual=scenarioPnl([l],scenario({daysForward:3}))!;
    const expected=(priceOption(l,{spot:100,forward:100,rate:0,dividend:0,days:7,model:'BSM'}).value-8)*100;
    expect(actual).toBeCloseTo(expected,8);
    expect(actual).not.toBe(0);
  });
  it('returns the model mark minus entry premium at the current valuation point',()=>{
    const l=leg({premium:8});
    const actual=scenarioPnl([l],scenario())!;
    const theoretical=priceOption(l,{spot:100,forward:100,rate:0,dividend:0,days:10,model:'BSM'}).value;
    expect(actual).toBeCloseTo((theoretical-8)*100,8);
  });
  it('uses one common price coordinate grid and the same price-IV matrix for 2D and 3D slices',()=>{
    const xs=commonPriceGrid(100,[90,110]);
    expect(xs).toHaveLength(101);
    const grid=calculateScenarioGrid(100,(spot,iv)=>scenarioPnl([leg()],scenario({spot,ivShift:iv/100})));
    const gridSpot=100*(1+grid.ps[8]/100), gridIv=grid.vs[6];
    expect(grid.z[6][8]).toBeCloseTo(scenarioPnl([leg()],scenario({spot:gridSpot,ivShift:gridIv/100}))!,10);
    expect(hasCommonExpiry([leg(),leg({id:'leg-2',expiry:'2026-11-24'})])).toBe(false);
  });
  it('does not price an option leg with a non-positive shocked IV before expiry',()=>{
    expect(scenarioPnl([leg()],scenario({ivShift:-.25}))).toBeNull();
  });
});
