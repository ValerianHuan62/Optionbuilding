import { describe, expect, it } from 'vitest';
import type { OptionLeg } from '../models/option';
import { priceOption } from '../engine/pricing';
import { scenarioPnl, scenarioPnlDiagnostics } from '../engine/scenario';

const make=(id:string,type:'CALL'|'PUT',side:'LONG'|'SHORT',strike:number,expiry='2026-12-24',q=.087)=>({
  id,contractId:id,optionType:type,side,strike,premium:20,marketEntryPremium:20,quantity:1,multiplier:100,expiry,iv:.24,greeks:{},
  modelSpot:5797.089,modelRate:.0166,modelTime:(Date.parse(`${expiry}T00:00:00Z`)-Date.parse('2025-01-02T00:00:00Z'))/86400000/365,
  dividendYield:q,qStatus:'OK',
} as OptionLeg);
const zero={spot:5797.089,valuationDate:'2025-01-02',daysForward:0,ivShift:0,rate:1.66,dividend:Number.NaN};

describe('model and market baselines',()=>{
  it.each([
    ['single call',[make('C','CALL','LONG',5800)]],
    ['single put',[make('P','PUT','SHORT',5800)]],
    ['bull call spread',[make('BC-L','CALL','LONG',5750),make('BC-S','CALL','SHORT',5850)]],
    ['bear call spread',[make('BR-S','CALL','SHORT',5750),make('BR-L','CALL','LONG',5850)]],
    ['iron condor',[make('IC-PL','PUT','LONG',5600),make('IC-PS','PUT','SHORT',5700),make('IC-CS','CALL','SHORT',5900),make('IC-CL','CALL','LONG',6000)]],
    ['calendar spread',[make('CAL-L','CALL','LONG',5800,'2026-12-24'),make('CAL-S','CALL','SHORT',5800,'2026-11-27')]],
  ])('%s has zero model-baseline PnL for 0/0/0',(_name,legs)=>{
    expect(scenarioPnl(legs as OptionLeg[],{...zero,basis:'MODEL'})).toBeCloseTo(0,10);
  });

  it('keeps the market Mid gap visible while model PnL is zero',()=>{
    const leg=make('C','CALL','LONG',5800);
    const result=scenarioPnlDiagnostics([leg],zero);
    expect(result.modelPnl).toBeCloseTo(0,10);
    expect(result.marketPnl).toBeCloseTo(result.modelMarketGap!,10);
    expect(result.legs[0].baseBsm).not.toBe(result.legs[0].mid);
    expect(result.legs[0].gapContribution).toBeCloseTo(result.marketPnl!,10);
  });

  it('uses expiry-specific q and does not silently price when q is missing',()=>{
    const leg=make('C','CALL','LONG',5800), input={spot:5797.089,rate:1.66,days:350};
    const lowQ=priceOption(leg,{...input,dividend:1}).value;
    const highQ=priceOption(leg,{...input,dividend:12}).value;
    expect(lowQ).not.toBeCloseTo(highQ,5);
    expect(scenarioPnlDiagnostics([{...leg,dividendYield:null}],{...zero,dividend:Number.NaN}).modelPnl).toBeNull();
  });

  it.each(['CALL','PUT'] as const)('round-trips database BSM IV to its Mid for %s',optionType=>{
    const leg=make('RT',optionType,'LONG',5800),price=priceOption(leg,{spot:leg.modelSpot!,rate:leg.modelRate!*100,dividend:leg.dividendYield!*100,days:leg.modelTime!*365}).value;
    const result=scenarioPnlDiagnostics([{...leg,premium:price,marketEntryPremium:price}],zero);
    expect(result.initialModelValue).toBeCloseTo(result.initialMarketValue,8);
    expect(result.modelMarketGap).toBeCloseTo(0,8);
    expect(result.marketPnl).toBeCloseTo(0,8);
  });
});
