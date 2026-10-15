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
  it('uses fast-futures raw point units and applies the contract multiplier once',()=>{
    const result=normalizeGreeks({delta:.4531,gamma:.00113,theta:-1.04,vega:3.28,rho:2.5},100,'KUAIQI_RAW');
    expect(result.delta).toBeCloseTo(45.31,8); expect(result.gamma).toBeCloseTo(.113,8);
    expect(result.theta).toBe(-104); expect(result.vega).toBe(328); expect(result.rho).toBe(250);
  });
  it('migrates saved legacy Greeks into the new fixed raw-point input units',()=>{
    const chain=[contract({greeks:{delta:.5,gamma:.002,theta:-1.2,vega:450,rho:200,source:'LEGACY_POINTS'}})];
    const migrated=migrateWorkbenchState({...defaults,optionChain:chain},defaults);
    expect(migrated.greekInputFormat).toBe('KUAIQI_RAW');
    expect(migrated.optionChain[0].greeks).toMatchObject({delta:.5,gamma:.002,theta:-1.2,vega:4.5,rho:2,source:'KUAIQI_RAW'});
    expect(normalizeGreeks(migrated.optionChain[0].greeks,100,migrated.greekInputFormat)).toMatchObject({delta:50,gamma:.2,theta:-120,vega:450,rho:200});
  });
  it('repairs the first unversioned quick-unit snapshot without rescaling Vega or Rho',()=>{
    const chain=[contract({greeks:{delta:.00509,gamma:.0000209,theta:-.0127,vega:4.92,rho:2,source:'KUAIQI_RAW'}})];
    const migrated=migrateWorkbenchState({...defaults,greekInputFormat:'KUAIQI_RAW',optionChain:chain},defaults);
    expect(migrated.optionChain[0].greeks).toMatchObject({delta:.509,gamma:.00209,theta:-1.27,vega:4.92,rho:2,source:'KUAIQI_RAW'});
    expect(migrated.greekUnitsVersion).toBe(1);
  });
  it('normalizes raw delta, theta, vega and rho with one multiplier conversion',()=>{
    const result=normalizeGreeks({delta:.4531,theta:-5123.2955,vega:251.0965,rho:26.6675},100,'TONGHUASHUN_RAW',{thetaUnit:'YEAR',vegaUnit:'IV_DECIMAL',rhoUnit:'RATE_DECIMAL',includesMultiplier:false});
    expect(result.delta).toBeCloseTo(45.31,8);
    expect(result.theta).toBeCloseTo(-1403.6426,3);
    expect(result.vega).toBeCloseTo(251.0965,8);
    expect(result.rho).toBeCloseTo(26.6675,8);
  });
  it('does not reapply multiplier to standardized single-contract CNY values',()=>{
    expect(normalizeGreeks({delta:45.31,vega:251.0965},100,'STANDARDIZED')).toMatchObject({delta:45.31,vega:251.0965});
  });
});

describe('revalued scenario PnL',()=>{
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
