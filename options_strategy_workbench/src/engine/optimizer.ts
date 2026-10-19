import type { Costs, GreekValues, OptionContract, OptionLeg, Side, WorkbenchState } from '../models/option';
import { analyzePayoff, type PayoffAnalysis } from './payoffAnalyzer';
import { grossExpirationPnl, sign } from './payoff';
import { marginForContract } from './margin';
import { priceOption } from './pricing';
import { dividendYieldFor } from '../utils/dividendYield';

export type StrategyKind = 'BULL_CALL' | 'BEAR_CALL' | 'BULL_PUT' | 'BEAR_PUT' | 'IRON_CONDOR' | 'IRON_BUTTERFLY' | 'LONG_STRADDLE' | 'SHORT_STRADDLE' | 'LONG_STRANGLE' | 'SHORT_STRANGLE';
export type EntryMode = 'EXECUTABLE' | 'MID';
export type RankMetric = 'EXPECTED' | 'EXPECTED_LOSS' | 'EXPECTED_MARGIN';
export type Scenario = { id: string; name: string; movePct: number; ivPp: number; days: number; probability: number };
export type Limit = { enabled: boolean; value: number };
export type GreekPreferences = { negativeDelta: boolean; negativeVega: boolean; positiveTheta: boolean };
export type IvQuality = { status: 'PASS' | 'WARNING' | 'REJECT'; issues: string[] };
export type OptimizerLimits = { maxLoss: Limit; maxMargin: Limit; maxScenarioLoss: Limit; maxDelta: Limit; maxGamma: Limit; maxVega: Limit; maxSpread: Limit; minVolume: Limit; minOpenInterest: Limit; maxLegs: Limit };
export type OptimizerSettings = { greekUnitsVersion: 2; underlying: string; expiry: string; strategy: StrategyKind; entryMode: EntryMode; strikeMin: number; strikeMax: number; widthMin: number; widthMax: number; shortAtmMin: number; shortAtmMax: number; bearCallAtmFilter: boolean; atmTolerance: number; greekPreferences: GreekPreferences; asymmetric: boolean; scenarios: Scenario[]; limits: OptimizerLimits; costs: Costs };
export type Position = { contract: OptionContract; side: Side };
export type PointGreeks = { delta: number; gamma: number; theta: number; vega: number; rho: number };
export type ScenarioMark = { value: number; greeks: PointGreeks | null };
export type Candidate = { id: string; positions: Position[]; legs: OptionLeg[]; payoff: PayoffAnalysis; entryPnl: 0; netPremium: number; maxProfit: number | 'UNLIMITED'; maxLoss: number | 'UNLIMITED'; margin: number | null; entryFees: number; exitFees: number; settlementFees: number; scenarioPnls: number[]; expiryScenarioPnls: number[]; scenarioPnlGaps: number[]; expiryWorstScenario: number; ivQuality: IvQuality; initialMoneyness: number; scenarioGreeks: (PointGreeks | null)[]; entryGreeks: (PointGreeks | null)[]; baseGreeks: PointGreeks; reversalCount: number; maxAbsGreeks: PointGreeks; worstScenario: number; breakEvens: number[] };
export type Counts = { enumerated: number; structure: number; quotes: number; pricing: number; risk: number; ranked: number; reasons: Record<string, number> };
export type Prepared = { settings: OptimizerSettings; state: WorkbenchState; contracts: OptionContract[]; marks: Map<string, ScenarioMark[]>; baseMarks: Map<string, ScenarioMark>; counts: Counts; daysToExpiry: number };
export type ScoredCandidate = Candidate & { expected: number; expectedLoss: number | null; expectedMargin: number | null; profitableWeight: number; expiryProfitableWeight: number; expectedPnlGap: number; rank: number };
export type RobustStats = { id: string; mean: number; sd: number; p5: number; positiveFraction: number; medianRank: number; top5Fraction: number; worstRank: number; robustScore: number | null; robustRank: number };

export const DEFAULT_SCENARIOS: Scenario[] = [
  { id: 's1', name: '温和下跌', movePct: -2, ivPp: -5, days: 1, probability: 30 },
  { id: 's2', name: '恐慌下跌', movePct: -5, ivPp: 8, days: 1, probability: 10 },
  { id: 's3', name: '横盘降波', movePct: 0, ivPp: -8, days: 1, probability: 25 },
  { id: 's4', name: '温和上涨', movePct: 2, ivPp: -5, days: 1, probability: 20 },
  { id: 's5', name: '强势上涨', movePct: 5, ivPp: 5, days: 1, probability: 5 },
  { id: 's6', name: '下跌升波', movePct: -3, ivPp: 3, days: 1, probability: 10 },
];
const limit = (enabled: boolean, value: number): Limit => ({ enabled, value });
export function defaultSettings(state: WorkbenchState): OptimizerSettings {
  const width = Math.max(50, Math.round(state.spot * .03 / 50) * 50);
  return { greekUnitsVersion: 2, underlying: state.underlying, expiry: state.expiry, strategy: 'BEAR_CALL', entryMode: 'EXECUTABLE', strikeMin: 0, strikeMax: Infinity, widthMin: 1, widthMax: width * 3, shortAtmMin: 0, shortAtmMax: Infinity, bearCallAtmFilter: true, atmTolerance: 100, greekPreferences: {negativeDelta:false,negativeVega:false,positiveTheta:false}, asymmetric: true, scenarios: DEFAULT_SCENARIOS.map(x => ({ ...x })), costs: { ...state.costs }, limits: {
    maxLoss: limit(true, 30000), maxMargin: limit(true, 150000), maxScenarioLoss: limit(true, 25000), maxDelta: limit(false, 1), maxGamma: limit(false, .01), maxVega: limit(false, 10), maxSpread: limit(true, 10), minVolume: limit(true, 1), minOpenInterest: limit(true, 1), maxLegs: limit(false, 4),
  } };
}
/** Saved v1 risk limits were cash Greeks; the workbench displays Greeks in option points. */
export function migrateGreekLimits(limits: OptimizerLimits, multiplier: number, alreadyPointBased: boolean): OptimizerLimits {
  if (alreadyPointBased || !Number.isFinite(multiplier) || multiplier <= 0) return limits;
  return { ...limits,
    maxDelta: { ...limits.maxDelta, value: limits.maxDelta.value / multiplier },
    maxGamma: { ...limits.maxGamma, value: limits.maxGamma.value / multiplier },
    maxVega: { ...limits.maxVega, value: limits.maxVega.value / multiplier },
  };
}
export function validateProbabilities(scenarios: Scenario[]): string | null {
  if (!scenarios.length) return '至少保留一个情景。';
  if (scenarios.some(s => !Number.isFinite(s.probability) || s.probability < 0 || s.probability > 100)) return '每个情景概率须在 0–100% 内。';
  const sum = scenarios.reduce((a, b) => a + b.probability, 0);
  return Math.abs(sum - 100) <= 1e-6 ? null : `概率合计 ${sum.toFixed(4)}%，须等于 100%。`;
}
export function shiftProbability(scenarios: Scenario[], index: number, next: number, locked: Set<string> = new Set()): Scenario[] | null {
  if (!Number.isFinite(next) || next < 0 || next > 100 || locked.has(scenarios[index]?.id)) return null;
  const fixed = scenarios.reduce((sum, s, i) => sum + (i !== index && locked.has(s.id) ? s.probability : 0), 0);
  const others = scenarios.map((s,i)=>i).filter(i => i !== index && !locked.has(scenarios[i].id));
  const remaining = 100 - fixed - next;
  if (remaining < -1e-8 || (!others.length && Math.abs(remaining) > 1e-8)) return null;
  const oldSum = others.reduce((sum,i)=>sum+scenarios[i].probability,0);
  return scenarios.map((s,i) => ({ ...s, probability: i === index ? next : locked.has(s.id) ? s.probability : others.includes(i) ? oldSum > 0 ? s.probability * remaining / oldSum : remaining / others.length : s.probability }));
}
export function validateSettings(settings: OptimizerSettings, state: WorkbenchState): string | null {
  const probabilityError = validateProbabilities(settings.scenarios);
  if (probabilityError) return probabilityError;
  if (!Number.isFinite(state.spot) || state.spot <= 0) return '标的现货必须为正数。';
  if (settings.scenarios.some(s=>!Number.isFinite(s.movePct)||!Number.isFinite(s.ivPp)||!Number.isInteger(s.days)||s.days<0)) return '情景变动和自然日必须有效。';
  const days = calendarDays(settings.expiry, state.valuationDate);
  if (days < 0 || settings.scenarios.some(s=>s.days>days)) return `情景推进不能超过剩余 ${Math.max(0,days)} 天。`;
  if (![settings.strikeMin,settings.widthMin,settings.shortAtmMin,settings.atmTolerance].every(x=>Number.isFinite(x)&&x>=0) || settings.strikeMax<settings.strikeMin || settings.widthMax<settings.widthMin || settings.shortAtmMax<settings.shortAtmMin) return '执行价、翼宽或 ATM 容差无效。';
  if (Object.values(settings.limits).some(x=>x.enabled&&(!Number.isFinite(x.value)||x.value<0))) return '已启用的风险阈值须为非负数。';
  if (Object.values(settings.costs).some(x=>!Number.isFinite(x)||x<0)) return '手续费须为非负数。';
  return null;
}
const calendarDays = (expiry: string, valuation?: string) => (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${valuation ?? new Date().toISOString().slice(0,10)}T00:00:00Z`)) / 86400000;
const emptyGreeks = (): PointGreeks => ({ delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 });
const addGreeks = (sum: PointGreeks, item: PointGreeks | null, scale: number) => { if (!item) return; for (const key of Object.keys(sum) as (keyof PointGreeks)[]) sum[key] += item[key] * scale; };
const pointGreeks = (raw: NonNullable<ReturnType<typeof priceOption>['greeks']>): PointGreeks => ({ delta: raw.delta!, gamma: raw.gamma!, theta: raw.theta!, vega: raw.vega * .01, rho: raw.rho! * .01 });
export function expirationScenarioPnls(legs: OptionLeg[], scenarios: Scenario[], spot: number, entryFees=0, settlementFees=0): number[] {
  return scenarios.map(s=>grossExpirationPnl(legs,spot*(1+s.movePct/100))-entryFees-settlementFees);
}
const record = (counts: Counts, reason: string) => { counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1; };
export function greekRiskSummary(base: PointGreeks, scenarios: (PointGreeks | null)[]) {
  const maxAbs=emptyGreeks();let reversals=0;
  for(const g of scenarios) {if(!g)continue;let reversed=false;
    for(const key of Object.keys(g) as (keyof PointGreeks)[]) {maxAbs[key]=Math.max(maxAbs[key],Math.abs(g[key]));if(key!=='rho'&&Math.abs(base[key])>1e-10&&Math.abs(g[key])>1e-10&&Math.sign(base[key])!==Math.sign(g[key]))reversed=true;}
    if(reversed)reversals++;
  }
  return {reversals,maxAbs};
}

export function prepareOptimization(state: WorkbenchState, settings: OptimizerSettings): Prepared {
  const error = validateSettings(settings,state); if (error) throw new Error(error);
  const universe=new Map<string,OptionContract>();
  const quality=(c:OptionContract)=>Number(c.bid!=null&&c.ask!=null)*8+Number(c.impliedVolatility!=null)*4+Number(c.volume!=null)*2+Number(!c.contractId.startsWith('['));
  for(const c of state.optionChain.filter(c=>c.underlying===settings.underlying&&c.expiry===settings.expiry&&c.strike>=settings.strikeMin&&c.strike<=settings.strikeMax)) {
    const key=`${c.optionType}:${c.strike}`,previous=universe.get(key);
    if(!previous||quality(c)>quality(previous))universe.set(key,c);
  }
  const contracts=[...universe.values()].sort((a,b)=>a.strike-b.strike);
  const marks = new Map<string, ScenarioMark[]>(), baseMarks = new Map<string, ScenarioMark>();
  const daysToExpiry = calendarDays(settings.expiry,state.valuationDate);
  const dividend = dividendYieldFor(settings.underlying,state.dividendYield);
  for (const c of contracts) {
    if (!Number.isFinite(c.impliedVolatility)||c.impliedVolatility!<=0) continue;
    const valueAt = (spot: number, iv: number, days: number): ScenarioMark => {
      const quote=priceOption({optionType:c.optionType,strike:c.strike,iv},{spot,rate:state.riskFreeRate,dividend,days});
      return {value:quote.value,greeks:quote.greeks?pointGreeks(quote.greeks):null};
    };
    const base=valueAt(state.spot,c.impliedVolatility!,daysToExpiry);
    if (!Number.isFinite(base.value)) continue;
    baseMarks.set(c.contractId,base);
    marks.set(c.contractId,settings.scenarios.map(s=>valueAt(state.spot*(1+s.movePct/100),c.impliedVolatility!+s.ivPp/100,daysToExpiry-s.days)));
  }
  return {state,settings,contracts,marks,baseMarks,daysToExpiry,counts:{enumerated:0,structure:0,quotes:0,pricing:0,risk:0,ranked:0,reasons:{}}};
}

export function* enumerateStructures(prep: Prepared): Generator<Position[]> {
  const {settings,state}=prep;
  const calls=prep.contracts.filter(c=>c.optionType==='CALL'), puts=prep.contracts.filter(c=>c.optionType==='PUT');
  const within = (a: OptionContract,b: OptionContract) => { const w=b.strike-a.strike; return w>=settings.widthMin&&w<=settings.widthMax; };
  const nearAtm = (c: OptionContract) => { const d=Math.abs(c.strike-state.spot); return d>=settings.shortAtmMin&&d<=settings.shortAtmMax; };
  const leg=(contract:OptionContract,side:Side):Position=>({contract,side});
  if (settings.strategy==='BULL_CALL'||settings.strategy==='BEAR_CALL'||settings.strategy==='BULL_PUT'||settings.strategy==='BEAR_PUT') {
    const pool=settings.strategy.endsWith('CALL')?calls:puts;
    for(let i=0;i<pool.length;i++) for(let j=i+1;j<pool.length;j++) {
      const a=pool[i],b=pool[j]; if(!within(a,b)) continue;
      const bull=settings.strategy.startsWith('BULL');
      const first:Side=settings.strategy.endsWith('CALL')?(bull?'LONG':'SHORT'):(bull?'SHORT':'LONG');
      const short=first==='SHORT'?a:b; if(!nearAtm(short)) continue;
      if(settings.strategy==='BEAR_CALL'&&settings.bearCallAtmFilter&&short.strike<state.spot-settings.atmTolerance) continue;
      yield [leg(a,first),leg(b,first==='LONG'?'SHORT':'LONG')];
    }
  } else if(settings.strategy==='IRON_CONDOR'||settings.strategy==='IRON_BUTTERFLY') {
    for(let i=0;i<puts.length;i++) for(let j=i+1;j<puts.length;j++) {
      const lp=puts[i],sp=puts[j]; if(!within(lp,sp)||!nearAtm(sp)) continue;
      for(let k=0;k<calls.length;k++) { const sc=calls[k]; if(settings.strategy==='IRON_BUTTERFLY'?sc.strike!==sp.strike:sc.strike<=sp.strike) continue;
        if(!nearAtm(sc)) continue;
        for(let l=k+1;l<calls.length;l++) { const lc=calls[l]; if(!within(sc,lc)) continue;
          if(!settings.asymmetric&&Math.abs((sp.strike-lp.strike)-(lc.strike-sc.strike))>1e-8) continue;
          yield [leg(lp,'LONG'),leg(sp,'SHORT'),leg(sc,'SHORT'),leg(lc,'LONG')];
        }
      }
    }
  } else if(settings.strategy.endsWith('STRADDLE')) {
    const putByStrike=new Map(puts.map(c=>[c.strike,c])); const side=settings.strategy.startsWith('LONG')?'LONG':'SHORT';
    for(const c of calls) {const p=putByStrike.get(c.strike);if(p&&(side==='LONG'||nearAtm(c))) yield [leg(p,side),leg(c,side)];}
  } else if(settings.strategy.endsWith('STRANGLE')) {
    const side=settings.strategy.startsWith('LONG')?'LONG':'SHORT';
    for(const p of puts) for(const c of calls) if(p.strike<c.strike&&(side==='LONG'||(nearAtm(p)&&nearAtm(c)))) yield [leg(p,side),leg(c,side)];
  }
}

function entryPrice(c: OptionContract, side: Side, mode: EntryMode): number | null {
  if(mode==='EXECUTABLE') return side==='LONG'?c.ask??null:c.bid??null;
  return c.marketPremium ?? c.premium ?? (c.bid!=null&&c.ask!=null?(c.bid+c.ask)/2:null);
}
const marketReference=(c:OptionContract)=>c.marketPremium??c.premium??(c.bid!=null&&c.ask!=null?(c.bid+c.ask)/2:null);
export function assessQuoteQuality(positions: Position[], state: WorkbenchState, settings: OptimizerSettings, days: number): IvQuality {
  const reject:string[]=[],warnings:string[]=[],t=Math.max(0,days)/365,r=state.riskFreeRate/100,q=dividendYieldFor(settings.underlying,state.dividendYield)/100;
  for(const {contract:c} of positions){
    if(!Number.isFinite(c.impliedVolatility)||c.impliedVolatility!<=0){reject.push(`${c.contractId}：IV 无效`);continue;}
    const reference=marketReference(c),lower=c.optionType==='CALL'?Math.max(0,state.spot*Math.exp(-q*t)-c.strike*Math.exp(-r*t)):Math.max(0,c.strike*Math.exp(-r*t)-state.spot*Math.exp(-q*t));
    if(reference===null||!Number.isFinite(reference)||reference<lower-.1)reject.push(`${c.contractId}：行情价格低于 BSM 欧式下界`);
    const itm=c.optionType==='CALL'?(state.spot-c.strike)/state.spot:(c.strike-state.spot)/state.spot;
    if(itm>=.08&&c.impliedVolatility!>=.8)warnings.push(`${c.contractId}：深度 ITM 且 IV ≥ 80%，请核对反算输入`);
    if(c.quoteAt&&c.ivAt){
      const quoteTime=Date.parse(c.quoteAt),ivTime=Date.parse(c.ivAt);
      const quoteDateOnly=/^\d{4}-\d{2}-\d{2}$/.test(c.quoteAt),ivDateOnly=/^\d{4}-\d{2}-\d{2}$/.test(c.ivAt);
      if(!Number.isFinite(quoteTime)||!Number.isFinite(ivTime))reject.push(`${c.contractId}：行情或 IV 时间无效`);
      else if(c.quoteAt.slice(0,10)!==c.ivAt.slice(0,10))reject.push(`${c.contractId}：IV 与行情日期不同`);
      else if(quoteDateOnly||ivDateOnly)warnings.push(`${c.contractId}：IV 或报价仅有日期，无法核验盘中同步`);
      else if(Math.abs(quoteTime-ivTime)>5*60_000)reject.push(`${c.contractId}：IV 与报价时间相差超过 5 分钟`);
    }else warnings.push(`${c.contractId}：缺少 IV / 报价独立时间，无法核验同步`);
  }
  for(const type of ['CALL','PUT'] as const){
    const ordered=positions.filter(p=>p.contract.optionType===type).sort((a,b)=>a.contract.strike-b.contract.strike);
    for(let i=1;i<ordered.length;i++){
      const lo=ordered[i-1].contract,hi=ordered[i].contract,a=marketReference(lo),b=marketReference(hi);
      if(a===null||b===null)continue;
      const vertical=type==='CALL'?a-b:b-a,upper=(hi.strike-lo.strike)*Math.exp(-r*t);
      if(vertical<-.1)reject.push(`${type} 行情价格未随执行价单调变化`);
      if(vertical>upper+.1)reject.push(`${type} 行情垂直价差超过无套利上界`);
      if(Math.abs((lo.impliedVolatility??0)-(hi.impliedVolatility??0))>=.2)warnings.push(`${type} 相邻组合腿 IV 相差 ≥ 20pp`);
    }
  }
  const times=positions.map(p=>p.contract.quoteAt?.trim()).filter((x):x is string=>!!x);
  if(times.length!==positions.length)warnings.push('缺少逐腿原始行情时间，无法确认同步');
  else {
    const parsed=times.map(x=>Date.parse(x)),dates=times.map(x=>x.slice(0,10));
    if(parsed.some(x=>!Number.isFinite(x)))reject.push('逐腿行情时间无效');
    else if(new Set(dates).size>1||state.valuationDate&&dates.some(x=>x!==state.valuationDate))reject.push('逐腿行情日期与估值日不一致');
    else if(times.some(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)))warnings.push('只有行情日期，无法核对盘中同步');
    else if(Math.max(...parsed)-Math.min(...parsed)>5*60_000)reject.push('逐腿行情时间相差超过 5 分钟');
  }
  return {status:reject.length?'REJECT':warnings.length?'WARNING':'PASS',issues:[...reject,...warnings]};
}
function validQuote(c: OptionContract, side: Side, settings: OptimizerSettings): boolean {
  const p=entryPrice(c,side,settings.entryMode);
  if(p===null||!Number.isFinite(p)||p<0) return false;
  if(settings.entryMode==='EXECUTABLE'&&(c.bid==null||c.ask==null||c.bid<0||c.ask<=0||c.ask<c.bid||c.quoteStatus&&c.quoteStatus!=='OK')) return false;
  const spread=(c.ask!=null&&c.bid!=null)?c.ask-c.bid:null;
  if(settings.limits.maxSpread.enabled&&(spread===null||spread>settings.limits.maxSpread.value)) return false;
  if(settings.limits.minVolume.enabled&&(!Number.isFinite(c.volume)||c.volume!<settings.limits.minVolume.value)) return false;
  if(settings.limits.minOpenInterest.enabled&&(!Number.isFinite(c.openInterest)||c.openInterest!<settings.limits.minOpenInterest.value)) return false;
  return true;
}
function surfaceValid(positions: Position[], marks: Map<string,ScenarioMark>, days: number, rate: number): boolean {
  const discount=Math.exp(-rate/100*Math.max(days,0)/365);
  for(const type of ['CALL','PUT'] as const) {
    const ordered=positions.filter(p=>p.contract.optionType===type).sort((a,b)=>a.contract.strike-b.contract.strike);
    for(let i=1;i<ordered.length;i++) {
      const lo=ordered[i-1].contract,hi=ordered[i].contract, a=marks.get(lo.contractId)?.value,b=marks.get(hi.contractId)?.value;
      if(a===undefined||b===undefined||!Number.isFinite(a)||!Number.isFinite(b)) return false;
      const spread=type==='CALL'?a-b:b-a;
      if(spread < -1e-5 || spread > (hi.strike-lo.strike)*discount+1e-5) return false;
    }
  }
  return true;
}
export function evaluateCandidate(prep: Prepared, positions: Position[]): Candidate | null {
  const {counts,settings,state}=prep; counts.enumerated++;
  if(settings.limits.maxLegs.enabled&&positions.length>settings.limits.maxLegs.value) {record(counts,'腿数约束');return null;}
  counts.structure++;
  if(settings.entryMode==='EXECUTABLE'&&positions.some(p=>p.contract.contractId.startsWith('['))) {record(counts,'缺少真实合约代码');return null;}
  if(!positions.every(p=>validQuote(p.contract,p.side,settings))) {record(counts,'报价 / 流动性不足');return null;}
  counts.quotes++;
  const legs:OptionLeg[]=positions.map(p=>({id:p.contract.contractId,optionType:p.contract.optionType,side:p.side,strike:p.contract.strike,premium:entryPrice(p.contract,p.side,settings.entryMode)!,quantity:1,multiplier:p.contract.multiplier,expiry:p.contract.expiry,iv:p.contract.impliedVolatility!,greeks:p.contract.greeks}));
  const ivQuality=assessQuoteQuality(positions,state,settings,prep.daysToExpiry);
  if(ivQuality.status==='REJECT'){record(counts,ivQuality.issues[0]);return null;}
  if(positions.some(p=>!prep.baseMarks.has(p.contract.contractId))) {record(counts,'IV / BSM 输入无效');return null;}
  if(!surfaceValid(positions,prep.baseMarks,prep.daysToExpiry,state.riskFreeRate)) {record(counts,'初始 BSM 曲面异常');return null;}
  const payoff=analyzePayoff(legs), entryFees=legs.length*settings.costs.openPerContract, exitFees=legs.length*settings.costs.closePerContract, settlementFees=legs.length*settings.costs.settlementPerContract;
  if(payoff.maxLoss!=='UNLIMITED'&&payoff.maxLoss>1e-6) {record(counts,'建仓报价套利异常');return null;}
  const maxProfit=payoff.maxProfit==='UNLIMITED'?'UNLIMITED':payoff.maxProfit-entryFees-settlementFees;
  const maxLoss=payoff.maxLoss==='UNLIMITED'?'UNLIMITED':Math.max(0,-payoff.maxLoss+entryFees+settlementFees);
  const baseGreeks=emptyGreeks(); const entryGreeks=positions.map(p=>prep.baseMarks.get(p.contract.contractId)!.greeks);
  positions.forEach((p,i)=>addGreeks(baseGreeks,entryGreeks[i],sign(p.side)));
  const preference=settings.greekPreferences;
  if(preference.negativeDelta&&baseGreeks.delta>=0||preference.negativeVega&&baseGreeks.vega>=0||preference.positiveTheta&&baseGreeks.theta<=0){record(counts,'Greeks 策略偏好');return null;}
  const marginRows=positions.filter(p=>p.side==='SHORT').map(p=>marginForContract(p.contract,{side:'SHORT',quantity:1},state.spot,state.marginParams??{m:.12,minimumRatio:.5}));
  const margin=marginRows.every(x=>x?.amount!=null)?marginRows.reduce((sum,x)=>sum+x!.amount!,0):null;
  const pnls:number[]=[],scenarioGreeks:(PointGreeks|null)[]=[];
  for(let i=0;i<settings.scenarios.length;i++) {
    const scenario=settings.scenarios[i], remaining=prep.daysToExpiry-scenario.days, marks=new Map<string,ScenarioMark>();
    positions.forEach(p=>marks.set(p.contract.contractId,prep.marks.get(p.contract.contractId)?.[i]??{value:NaN,greeks:null}));
    if([...marks.values()].some(mark=>!Number.isFinite(mark.value))) {record(counts,'情景 IV / BSM 无效');return null;}
    if(!surfaceValid(positions,marks,remaining,state.riskFreeRate)) {record(counts,'跨执行价 BSM 曲面异常');return null;}
    let pnl=-entryFees-(remaining===0?settlementFees:exitFees); const g=emptyGreeks();
    for(const p of positions) { const mark=marks.get(p.contract.contractId)!;
      if(!Number.isFinite(mark.value)) {record(counts,'情景 IV / BSM 无效');return null;}
      pnl+=sign(p.side)*(mark.value-entryPrice(p.contract,p.side,settings.entryMode)!)*p.contract.multiplier;
      addGreeks(g,mark.greeks,sign(p.side));
    }
    // Discount the extrema of the terminal payoff, then subtract the actual entry cash flow.
    const discount=Math.exp(-state.riskFreeRate/100*remaining/365);
    const lower=payoff.maxLoss==='UNLIMITED'?-Infinity:discount*(payoff.maxLoss+payoff.netDebit)-payoff.netDebit-entryFees-(remaining===0?settlementFees:exitFees);
    const upper=payoff.maxProfit==='UNLIMITED'?Infinity:discount*(payoff.maxProfit+payoff.netDebit)-payoff.netDebit-entryFees-(remaining===0?settlementFees:exitFees);
    const tolerance=Math.max(.1,positions.reduce((sum,p)=>sum+p.contract.multiplier,0)*state.spot*1e-7);
    if(pnl<lower-tolerance||pnl>upper+tolerance) {record(counts,'组合收益边界异常');return null;}
    pnls.push(pnl);scenarioGreeks.push(remaining>0?g:null);
  }
  counts.pricing++;
  const expiryScenarioPnls=expirationScenarioPnls(legs,settings.scenarios,state.spot,entryFees,settlementFees);
  const scenarioPnlGaps=pnls.map((x,i)=>x-expiryScenarioPnls[i]);
  const too=(key:keyof OptimizerLimits,value:number|null)=>settings.limits[key].enabled&&(value===null||value>settings.limits[key].value);
  if(too('maxLoss',maxLoss==='UNLIMITED'?null:maxLoss)||too('maxMargin',margin)||too('maxScenarioLoss',Math.max(0,-Math.min(...pnls)))||too('maxDelta',Math.abs(baseGreeks.delta))||too('maxGamma',Math.abs(baseGreeks.gamma))||too('maxVega',Math.abs(baseGreeks.vega))) {record(counts,'风险预算');return null;}
  counts.risk++; counts.ranked++;
  const {reversals:reversalCount,maxAbs:maxAbsGreeks}=greekRiskSummary(baseGreeks,scenarioGreeks);
  const terminal=(x:number)=>grossExpirationPnl(legs,x)-entryFees-settlementFees;
  const knots=[0,...new Set(legs.map(l=>l.strike))].sort((a,b)=>a-b), breakEvens:number[]=[];
  for(let i=0;i<knots.length;i++){const a=terminal(knots[i]);if(Math.abs(a)<1e-7)breakEvens.push(knots[i]);if(i>0){const b=terminal(knots[i-1]);if(a*b<0)breakEvens.push(knots[i-1]+(knots[i]-knots[i-1])*(-b)/(a-b));}}
  const last=knots.at(-1)!; const tailSlope=terminal(last+1)-terminal(last);if(Math.abs(tailSlope)>1e-8){const root=last-terminal(last)/tailSlope;if(root>=last)breakEvens.push(root);}
  const reference=positions.find(p=>p.side==='SHORT')?.contract??positions[0].contract;
  const initialMoneyness=(reference.optionType==='CALL'?reference.strike/state.spot-1:1-reference.strike/state.spot)*100;
  return {id:positions.map(p=>`${p.side[0]}${p.contract.optionType[0]}${p.contract.strike}`).join('/'),positions,legs,payoff,entryPnl:0,netPremium:payoff.netPremium,maxProfit,maxLoss,margin,entryFees,exitFees,settlementFees,scenarioPnls:pnls,expiryScenarioPnls,scenarioPnlGaps,expiryWorstScenario:Math.min(...expiryScenarioPnls),ivQuality,initialMoneyness,scenarioGreeks,entryGreeks,baseGreeks,reversalCount,maxAbsGreeks,worstScenario:Math.min(...pnls),breakEvens};
}

export function rankCandidates(candidates: Candidate[], scenarios: Scenario[], metric: RankMetric = 'EXPECTED'): ScoredCandidate[] {
  const error=validateProbabilities(scenarios);if(error)throw new Error(error);
  const weight=scenarios.map(s=>s.probability/100);
  return candidates.map(c=>{const expected=c.scenarioPnls.reduce((sum,pnl,i)=>sum+pnl*weight[i],0);return {...c,expected,expectedLoss:c.maxLoss==='UNLIMITED'||c.maxLoss<=0?null:expected/c.maxLoss,expectedMargin:c.margin===null||c.margin<=0?null:expected/c.margin,profitableWeight:c.scenarioPnls.reduce((sum,pnl,i)=>sum+(pnl>0?weight[i]:0),0),expiryProfitableWeight:c.expiryScenarioPnls.reduce((sum,pnl,i)=>sum+(pnl>0?weight[i]:0),0),expectedPnlGap:c.scenarioPnlGaps.reduce((sum,gap,i)=>sum+gap*weight[i],0),rank:0};})
    .sort((a,b)=>(metric==='EXPECTED'?b.expected-a.expected:metric==='EXPECTED_MARGIN'?(b.expectedMargin??-Infinity)-(a.expectedMargin??-Infinity):(b.expectedLoss??-Infinity)-(a.expectedLoss??-Infinity))||a.id.localeCompare(b.id)).map((x,i)=>({...x,rank:i+1}));
}
function rng(seed:number){let x=seed>>>0;return()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;};}
export function sampleProbabilities(base: Scenario[], amplitudePp:number, count:number, seed:number): number[][] {
  const error=validateProbabilities(base);if(error)throw new Error(error);
  if(!Number.isFinite(amplitudePp)||amplitudePp<0||!Number.isInteger(count)||count<1||!Number.isInteger(seed))throw new Error('扰动参数无效。');
  const baseline=base.map(s=>s.probability/100), radius=amplitudePp/100, random=rng(seed);
  return Array.from({length:count},()=>{const p=[...baseline];for(let k=0;k<Math.max(12,p.length*4);k++){
    const i=Math.floor(random()*p.length),j=Math.floor(random()*p.length);if(i===j)continue;
    const transfer=(random()*2-1)*radius/2;
    const lo=Math.max(-p[i],p[j]-1,baseline[i]-radius-p[i],p[j]-(baseline[j]+radius));
    const hi=Math.min(1-p[i],p[j],baseline[i]+radius-p[i],p[j]-(baseline[j]-radius));
    const actual=Math.min(hi,Math.max(lo,transfer));p[i]+=actual;p[j]-=actual;
  }return p;});
}
export function robustness(candidates: Candidate[], scenarios: Scenario[], amplitudePp=10, count=1000, seed=42, metric: RankMetric='EXPECTED'): RobustStats[] {
  const vectors=sampleProbabilities(scenarios,amplitudePp,count,seed), observations=new Map(candidates.map(c=>[c.id,{values:[] as number[],ranks:[] as number[],top5:0}]));
  const score=(value:number,c:Candidate)=>metric==='EXPECTED'?value:metric==='EXPECTED_LOSS'?c.maxLoss==='UNLIMITED'||c.maxLoss<=0?-Infinity:value/c.maxLoss:c.margin===null||c.margin<=0?-Infinity:value/c.margin;
  for(const p of vectors) {const ranked=candidates.map(c=>({id:c.id,value:c.scenarioPnls.reduce((sum,x,i)=>sum+x*p[i],0),candidate:c})).sort((a,b)=>
    score(b.value,b.candidate)-score(a.value,a.candidate)||a.id.localeCompare(b.id));
    ranked.forEach((r,i)=>{const o=observations.get(r.id)!;o.values.push(r.value);o.ranks.push(i+1);if(i<5)o.top5++;});
  }
  return candidates.map(c=>{const o=observations.get(c.id)!;const values=o.values,mean=values.reduce((a,b)=>a+b,0)/values.length,sorted=[...values].sort((a,b)=>a-b),ranks=[...o.ranks].sort((a,b)=>a-b),p5=sorted[Math.floor((sorted.length-1)*.05)];return {id:c.id,mean,sd:Math.sqrt(values.reduce((sum,x)=>sum+(x-mean)**2,0)/values.length),p5,positiveFraction:values.filter(x=>x>0).length/values.length,medianRank:ranks[Math.floor((ranks.length-1)/2)],top5Fraction:o.top5/values.length,worstRank:ranks.at(-1)!,robustScore:Number.isFinite(score(p5,c))?score(p5,c):null,robustRank:0};}).sort((a,b)=>(b.robustScore??-Infinity)-(a.robustScore??-Infinity)||a.id.localeCompare(b.id)).map((x,i)=>({...x,robustRank:i+1}));
}
export function loadCandidate(state: WorkbenchState, candidate: Candidate, settings: OptimizerSettings, saveForCompare=false): WorkbenchState {
  const merged=new Map(state.optionChain.map(c=>[c.contractId,c]));candidate.positions.forEach(p=>merged.set(p.contract.contractId,p.contract));
  const activeStrategy=candidate.legs.map(l=>({contractId:l.id,side:l.side,quantity:1,entryPremium:l.premium}));
  const next={...state,underlying:settings.underlying,expiry:settings.expiry,optionChain:[...merged.values()],activeStrategy,activeSavedStrategyId:null,costs:{...settings.costs}};
  if(!saveForCompare)return next;
  const now=new Date().toISOString();const id=`optimizer-${crypto.randomUUID()}`;
  return {...state,optionChain:[...merged.values()],savedStrategies:[...(state.savedStrategies??[]),{id,name:`${settings.strategy.replaceAll('_',' ')} · ${candidate.id}`,underlying:settings.underlying,createdAt:now,updatedAt:now,legs:activeStrategy,pricingSettings:{valuationDate:state.valuationDate,spot:state.spot,expiry:settings.expiry,riskFreeRate:state.riskFreeRate,dividendYield:dividendYieldFor(settings.underlying,state.dividendYield),multiplier:state.multiplier,marginParams:state.marginParams},transactionCosts:{...settings.costs},notes:`Strike Optimizer · ${settings.entryMode}`}]};
}
