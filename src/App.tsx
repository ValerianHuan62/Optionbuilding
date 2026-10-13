import { useEffect, useMemo, useRef, useState } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js/lib/core';
import scatter from 'plotly.js/lib/scatter';
import heatmap from 'plotly.js/lib/heatmap';
import { Activity, ArrowDownToLine, ArrowUpFromLine, BarChart3, Check, ChevronDown, Copy, Download, Plus, RotateCcw, Save, ShieldAlert, X } from 'lucide-react';
import type { Layout, Data } from 'plotly.js';
import type { GreekValues, OptionLeg, OptionType, WorkbenchState } from './models/option';
import { analyzePayoff } from './engine/payoffAnalyzer';
import { aggregateGreeks, legGreeks } from './engine/pricing';
import { classifyStrategy, shouldNotifyStrategy } from './engine/strategyClassifier';
import { scenarioPnl } from './engine/scenario';
import { legIsValid, legStructureIsValid } from './utils/validation';

const TODAY = '2026-10-12';
Plotly.register([scatter, heatmap]);
// react-plotly.js is CommonJS; Vite's optimized module wraps its default export.
const Plot = (createPlotlyComponent as unknown as { default: typeof createPlotlyComponent }).default(Plotly);
const INITIAL: WorkbenchState = { underlying: 'IO · 沪深300', spot: 4300, forward: 4300, expiry: '2026-12-24', daysToExpiry: 73, multiplier: 100, model: 'BSM', riskFreeRate: 1.65, dividendYield: 1.8, greeksMode: 'MANUAL', costs: { openPerContract: 0, closePerContract: 0, settlementPerContract: 0 }, legs: [] };
const calendarDays = (expiry:string) => Math.max(0,Math.ceil((new Date(`${expiry}T00:00:00`).getTime()-new Date(`${TODAY}T00:00:00`).getTime())/86400000));
const daysForLeg = (leg:OptionLeg,state:WorkbenchState) => Math.max(0,leg.expiry===state.expiry?state.daysToExpiry:calendarDays(leg.expiry));
const fmt = (n: number, digits = 2) => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const money = (n: number) => `${signed(n)} 元`;
const makeLeg = (type: OptionType, state: WorkbenchState): OptionLeg => ({ id: crypto.randomUUID(), optionType: type, side: 'LONG', strike: Math.round((Number.isFinite(state.spot) ? state.spot : 0) / 50) * 50, premium: 50, quantity: 1, multiplier: state.multiplier, expiry: state.expiry, iv: 0.2, greeks: {} });
const greekKeys: (keyof GreekValues)[] = ['delta', 'gamma', 'theta', 'vega', 'rho'];
const greekLabels: Record<keyof GreekValues, [string, string]> = { delta: ['DELTA', '元/点'], gamma: ['GAMMA', '元/点²'], theta: ['THETA', '元/天'], vega: ['VEGA', '元/IV百分点'], rho: ['RHO', '元/利率百分点'] };
const escapeCsv = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;

export default function App() {
  const [state, setState] = useState<WorkbenchState>(() => {
    try { const raw = localStorage.getItem('options-workbench-v1'); if (raw) { const saved = JSON.parse(raw); if (saved && typeof saved === 'object' && Array.isArray(saved.legs)) return { ...INITIAL, ...saved, costs:{...INITIAL.costs,...saved.costs} }; } } catch { /* start clean on an invalid local snapshot */ }
    return INITIAL;
  });
  const [showLegLines, setShowLegLines] = useState(false);
  const [showGross, setShowGross] = useState(false);
  const [priceShift, setPriceShift] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const [daysForward, setDaysForward] = useState(0);
  const [saved, setSaved] = useState<{ name: string; state: WorkbenchState }[]>(() => { try { return JSON.parse(localStorage.getItem('options-workbench-saved') ?? '[]'); } catch { return []; } });
  const [saveName, setSaveName] = useState('');
  const [toast, setToast] = useState('');
  const prevStrategy = useRef<string | null | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidStructure = state.legs.some(l => !legStructureIsValid(l));
  const invalidLegInput = state.legs.some(l => !legIsValid(l));
  const invalidCostInput = Object.values(state.costs).some(v => !Number.isFinite(v) || v < 0);
  const invalidGlobalInput = !Number.isFinite(state.daysToExpiry) || state.daysToExpiry < 0;
  const invalidInput = invalidLegInput || invalidCostInput || invalidGlobalInput;
  const validLegs = invalidStructure ? [] : state.legs;
  const analysisLegs = invalidInput ? [] : state.legs;
  const strategy = useMemo(() => classifyStrategy(validLegs), [state.legs, invalidStructure]);
  const multiExpiry = new Set(validLegs.map(l => l.expiry)).size > 1;
  const payoff = useMemo(() => analyzePayoff(analysisLegs, state.costs), [state.legs, state.costs, invalidInput]);
  const greekRows = useMemo(() => state.legs.map(l => ({ id: l.id, values: legGreeks(l, { spot: state.spot, forward: state.forward, rate: state.riskFreeRate, dividend: state.dividendYield, days: daysForLeg(l,state), model: state.model }, state.greeksMode) })), [state]);
  const portfolioGreeks = useMemo(() => invalidLegInput ? aggregateGreeks([]) : aggregateGreeks(greekRows.map(r => r.values)), [greekRows, invalidLegInput]);
  useEffect(() => { localStorage.setItem('options-workbench-v1', JSON.stringify(state)); }, [state]);
  useEffect(() => { localStorage.setItem('options-workbench-saved', JSON.stringify(saved)); }, [saved]);
  useEffect(() => {
    const name = strategy?.name ?? null;
    if (shouldNotifyStrategy(prevStrategy.current, name)) { setToast(name!); if (toastTimer.current) window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(''), 3000); }
    prevStrategy.current = name;
    return () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); };
  }, [strategy?.name]);

  const set = <K extends keyof WorkbenchState>(key: K, value: WorkbenchState[K]) => setState(s => ({ ...s, [key]: value }));
  const updateLeg = (id: string, patch: Partial<OptionLeg>) => set('legs', state.legs.map(l => l.id === id ? { ...l, ...patch } : l));
  const addLeg = (type: OptionType) => set('legs', [...state.legs, makeLeg(type, state)]);
  const removeLeg = (id: string) => set('legs', state.legs.filter(l => l.id !== id));
  const duplicateLeg = (leg: OptionLeg) => set('legs', [...state.legs, { ...leg, id: crypto.randomUUID() }]);
  const spotMin = Math.max(0, state.spot * (1 + priceShift / 100));
  const baseOpenFees = validLegs.reduce((sum, l) => sum + l.quantity * state.costs.openPerContract, 0);
  const maxScenarioDays = validLegs.length ? Math.max(0, ...validLegs.map(l => daysForLeg(l,state))) : state.daysToExpiry;
  const scenarioAt = (spot: number, vol: number, days: number) => invalidInput ? null : scenarioPnl(validLegs, { spot, forward: state.forward * spot / state.spot, valuationDate: TODAY, daysToExpiryByLeg:Object.fromEntries(validLegs.map(l=>[l.id,daysForLeg(l,state)])), daysForward: days, ivShift: vol / 100, rate: state.riskFreeRate, dividend: state.dividendYield, model: state.model, openFees: baseOpenFees, closePerContract: state.costs.closePerContract, settlementPerContract: state.costs.settlementPerContract });
  const scenarioValue = validLegs.length ? scenarioAt(spotMin, ivShift, daysForward) : null;
  const scenarioGrid = useMemo(() => {
    const ps = Array.from({ length: 15 }, (_, i) => -10 + i * 20 / 14), vs = Array.from({ length: 13 }, (_, i) => -10 + i * 20 / 12);
    return { ps, vs, z: vs.map(v => ps.map(p => scenarioAt(state.spot * (1 + p / 100), v, daysForward))) };
  }, [state, daysForward]);
  const scenarioGreeks = useMemo(() => invalidLegInput ? aggregateGreeks([]) : aggregateGreeks(validLegs.map(l => {
    const expiryDays = daysForLeg(l,state);
    const iv = l.iv + ivShift / 100;
    if (iv <= 0) return { delta:null,gamma:null,theta:null,vega:null,rho:null };
    return legGreeks({ ...l, iv }, { spot:spotMin, forward:state.forward*spotMin/state.spot, rate:state.riskFreeRate, dividend:state.dividendYield, days:Math.max(0,expiryDays-daysForward), model:state.model }, state.greeksMode);
  })), [state, ivShift, spotMin, daysForward, invalidLegInput]);
  const timeCurves = useMemo(() => {
    const days = [...new Set([0, Math.round(maxScenarioDays/2), maxScenarioDays])];
    const priceMoves = Array.from({length:41},(_,i)=>-10+i*.5);
    return { days, priceMoves, pnl:days.map(d=>priceMoves.map(p=>scenarioAt(state.spot*(1+p/100),ivShift,d))) };
  },[state,ivShift,maxScenarioDays]);
  const modelValid = state.spot > 0 && state.forward > 0 && !invalidInput;

  const saveNamed = () => {
    const name = saveName.trim(); if (!name) return;
    setSaved([...saved.filter(x => x.name !== name), { name, state }]); setSaveName('');
  };
  const download = (name: string, content: string, type: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };
  const exportJson = () => download('options-workbench.json', JSON.stringify({ version: 1, state }, null, 2), 'application/json');
  const importJson = async (file?: File) => {
    if (!file) return;
    try { const data = JSON.parse(await file.text()); const next = data?.state ?? data; if (!next || typeof next !== 'object' || !Array.isArray(next.legs) || !next.costs || !next.legs.every((l:OptionLeg)=>legIsValid(l) && ['CALL','PUT'].includes(l.optionType) && ['LONG','SHORT'].includes(l.side))) throw new Error('invalid'); setState({ ...INITIAL, ...next, costs:{...INITIAL.costs,...next.costs} }); }
    catch { window.alert('无法读取该组合 JSON 文件。'); }
    if (fileInput.current) fileInput.current.value = '';
  };
  const exportCsv = () => {
    const rows = [['标的价格（点）','IV平移（百分点）','估值日推进（天）','情景损益（元）']];
    for (let p = -10; p <= 10.001; p += 0.5) rows.push([fmt(state.spot * (1 + p / 100), 2), fmt(ivShift, 2), String(daysForward), scenarioAt(state.spot * (1 + p / 100), ivShift, daysForward) === null ? 'N/A' : fmt(scenarioAt(state.spot * (1 + p / 100), ivShift, daysForward)!, 2)]);
    download('scenario-analysis.csv', '\ufeff' + rows.map(row => row.map(escapeCsv).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  };
  const exportPng = () => { const plot = document.querySelector('.payoff-plot .js-plotly-plot') as HTMLElement; if (plot) void Plotly.downloadImage(plot, { format: 'png', filename: 'options-payoff', width: 1600, height: 900, scale: 2 }); };

  const safeSpot = Number.isFinite(state.spot) && state.spot >= 0 ? state.spot : 0;
  const rangeLo = Math.max(0, Math.min(safeSpot, ...(validLegs.length ? validLegs.map(l => l.strike) : [safeSpot])) * 0.75);
  const rangeHi = Math.max(safeSpot, ...validLegs.map(l => l.strike), 1) * 1.25;
  const chartX = [...new Set(Array.from({ length: 101 }, (_, i) => rangeLo + (rangeHi - rangeLo) * i / 100).concat(validLegs.map(l => l.strike), payoff.breakEvens, safeSpot))].sort((a, b) => a - b);
  const chartFees = showGross ? 0 : validLegs.reduce((sum, l) => sum + l.quantity * (state.costs.openPerContract + state.costs.settlementPerContract), 0);
  const chartY = chartX.map(x => validLegs.reduce((sum, l) => sum + (l.side === 'LONG' ? 1 : -1) * ((l.optionType === 'CALL' ? Math.max(x - l.strike, 0) : Math.max(l.strike - x, 0)) - l.premium) * l.quantity * l.multiplier, 0) - chartFees);
  const plusY = chartY.map(y => y > 0 ? y : null), minusY = chartY.map(y => y < 0 ? y : null);
  const chartData: Data[] = [
    { x: chartX, y: plusY, type: 'scatter', mode: 'lines', line: { color: '#698d7d', width: 2.5, shape: 'linear' }, fill: 'tozeroy', fillcolor: 'rgba(105,141,125,.13)', hoverinfo: 'skip', name: 'PROFIT' },
    { x: chartX, y: minusY, type: 'scatter', mode: 'lines', line: { color: '#c87868', width: 2.5, shape: 'linear' }, fill: 'tozeroy', fillcolor: 'rgba(200,120,104,.13)', hoverinfo: 'skip', name: 'LOSS' },
    { x: chartX, y: chartY, type: 'scatter', mode: 'lines', line: { color: '#343a3d', width: 2.4, shape: 'linear' }, customdata: chartX.map(x => state.legs.map(l => (l.side === 'LONG' ? 1 : -1) * ((l.optionType === 'CALL' ? Math.max(x - l.strike, 0) : Math.max(l.strike - x, 0)) - l.premium) * l.quantity * l.multiplier)), hovertemplate: `标的 %{x:.2f} 点<br>组合损益 %{y:,.2f} 元${state.legs.map((_,i)=>`<br>LEG ${String(i+1).padStart(2,'0')} %{customdata[${i}]:,.2f} 元`).join('')}<extra></extra>`, name: 'PORTFOLIO' },
  ];
  const payoffValueAt = (x:number) => validLegs.reduce((sum,l)=>sum+(l.side==='LONG'?1:-1)*((l.optionType==='CALL'?Math.max(x-l.strike,0):Math.max(l.strike-x,0))-l.premium)*l.quantity*l.multiplier,0)-chartFees;
  if (payoff.maxProfitAt !== 'UNLIMITED') chartData.push({ x: payoff.maxProfitAt, y: payoff.maxProfitAt.map(payoffValueAt), type:'scatter', mode:'markers', marker:{size:7,color:'#638778',line:{width:1,color:'#fff'}}, hovertemplate:'MAX PROFIT<br>%{x:.2f} 点<br>%{y:,.2f} 元<extra></extra>', name:'MAX PROFIT' });
  if (payoff.maxLossAt !== 'UNLIMITED') chartData.push({ x: payoff.maxLossAt, y: payoff.maxLossAt.map(payoffValueAt), type:'scatter', mode:'markers', marker:{size:7,color:'#bd7264',line:{width:1,color:'#fff'}}, hovertemplate:'MAX LOSS<br>%{x:.2f} 点<br>%{y:,.2f} 元<extra></extra>', name:'MAX LOSS' });
  if (showLegLines) validLegs.forEach((l, i) => chartData.push({ x: chartX, y: chartX.map(x => (l.side === 'LONG' ? 1 : -1) * ((l.optionType === 'CALL' ? Math.max(x - l.strike, 0) : Math.max(l.strike - x, 0)) - l.premium) * l.quantity * l.multiplier), type: 'scatter', mode: 'lines', line: { width: 1, dash: 'dot' }, opacity: .65, name: `LEG ${String(i + 1).padStart(2, '0')}` }));
  const shapes: NonNullable<Layout['shapes']> = [{ type: 'line', x0: rangeLo, x1: rangeHi, y0: 0, y1: 0, line: { color: '#a8adaf', width: 1, dash: 'dot' } }, { type: 'line', x0: state.spot, x1: state.spot, y0: Math.min(...chartY, 0), y1: Math.max(...chartY, 0), line: { color: '#ff623e', width: 1.4, dash: 'dash' } }, ...payoff.breakEvens.map(x => ({ type: 'line' as const, x0:x, x1:x, y0:Math.min(...chartY,0), y1:Math.max(...chartY,0), line:{color:'#6f997f',width:1,dash:'dash' as const} })), ...state.legs.map(l => ({ type: 'line' as const, x0: l.strike, x1: l.strike, y0: Math.min(...chartY, 0), y1: Math.max(...chartY, 0), line: { color: '#c8ccce', width: 1, dash: 'dot' as const } }))];
  const layout: Partial<Layout> = { autosize: true, height: 360, margin: { l: 64, r: 20, t: 16, b: 48 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#788084' }, xaxis: { title: { text: 'UNDERLYING PRICE · 指数点', font: { size: 10 } }, gridcolor: '#e9ebea', zeroline: false, range: [rangeLo, rangeHi] }, yaxis: { title: { text: 'PROFIT / LOSS · 元', font: { size: 10 } }, gridcolor: '#e9ebea', zeroline: false, tickformat: ',.0f' }, shapes, showlegend: false, hovermode: 'x unified', dragmode: 'pan' };

  return <main className="app-shell min-h-screen">
    <header className="topbar">
      <div className="brand-lock"><span className="signal-dot" /><div><div className="brand-title">OPTIONS <span>/</span> STRATEGY WORKBENCH</div><div className="brand-sub">衍生品结构与风险监测台</div></div></div>
      <div className="top-meta"><span className="live-led"><i /> LOCAL ENGINE</span><span className="top-date">12 OCT 2026 <span>·</span> SHANGHAI</span><button className="icon-button" title="导出组合 JSON" onClick={exportJson}><ArrowDownToLine size={15} /></button><button className="icon-button" title="导入组合 JSON" onClick={() => fileInput.current?.click()}><ArrowUpFromLine size={15} /></button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => void importJson(e.target.files?.[0])} /></div>
    </header>
    <section className="instrument-bar">
      <div className="instrument-cell"><label>UNDERLYING / 标的</label><select value={state.underlying} onChange={e => set('underlying', e.target.value)}><option>IO · 沪深300</option><option>MO · 中证1000</option><option>HO · 上证50</option><option>自定义指数</option></select></div>
      <div className="instrument-cell"><label>SPOT PRICE / 指数点</label><input type="number" value={state.spot} onChange={e => { const spot = +e.target.value; setState(s => ({ ...s, spot, forward: s.forward === s.spot ? spot : s.forward })); }} /></div>
      <div className="instrument-cell"><label>EXPIRY / 到期日</label><input type="date" value={state.expiry} onChange={e=>{const expiry=e.target.value;setState(s=>({ ...s,expiry,daysToExpiry:calendarDays(expiry),legs:s.legs.map(l=>l.expiry===s.expiry?{...l,expiry}:l) }));}} /></div>
      <div className="instrument-cell"><label>DAYS TO EXPIRY / 日</label><input type="number" min="0" step="1" value={state.daysToExpiry} onChange={e=>set('daysToExpiry',+e.target.value)} /></div>
      <div className="instrument-cell"><label>CONTRACT MULTIPLIER / 元·点⁻¹</label><input type="number" value={state.multiplier} onChange={e => { const multiplier = +e.target.value; setState(s => ({ ...s, multiplier, legs: s.legs.map(l => ({ ...l, multiplier })) })); }} /></div>
      <div className="instrument-cell model-select"><label>PRICING MODEL / 定价</label><select value={state.model} onChange={e => set('model', e.target.value as WorkbenchState['model'])}><option value="BSM">BLACK–SCHOLES–MERTON</option><option value="BLACK76">BLACK–76</option></select></div>
    </section>
    <div className="workspace-grid">
      <aside className="panel builder-panel">
        <div className="panel-heading"><div><span className="eyebrow">01 / COMPOSITION</span><h2>OPTION BUILDER</h2></div><span className="count-stamp">{String(state.legs.length).padStart(2, '0')} LEGS</span></div>
        <div className="builder-toolbar"><button className="add-button call-add" onClick={() => addLeg('CALL')}><Plus size={14} /> ADD CALL</button><button className="add-button put-add" onClick={() => addLeg('PUT')}><Plus size={14} /> ADD PUT</button><button className="clear-button" disabled={!state.legs.length} onClick={() => { set('legs', []); }}>CLEAR</button></div>
        {state.legs.length === 0 ? <div className="builder-empty"><div className="empty-schematic"><span /><span /><span /></div><b>NO ACTIVE LEGS</b><p>从独立期权腿开始构建。<br />结构识别将在组合形成后自动运行。</p></div> : <div className="leg-stack">{state.legs.map((leg, i) => <article className="leg-card" key={leg.id}>
          <div className="leg-card-head"><span className={`leg-index ${leg.optionType.toLowerCase()}`}>{String(i + 1).padStart(2, '0')}</span><select className={`type-select ${leg.optionType.toLowerCase()}`} value={leg.optionType} onChange={e => updateLeg(leg.id, { optionType: e.target.value as OptionType })}><option value="CALL">CALL</option><option value="PUT">PUT</option></select><select className={`side-select ${leg.side.toLowerCase()}`} value={leg.side} onChange={e => updateLeg(leg.id, { side: e.target.value as OptionLeg['side'] })}><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select><button className="tiny-icon" title="复制期权腿" onClick={() => duplicateLeg(leg)}><Copy size={13} /></button><button className="tiny-icon remove" title="删除期权腿" onClick={() => removeLeg(leg.id)}><X size={14} /></button></div>
          <div className="leg-fields"><NumField label="STRIKE · 点" value={leg.strike} onChange={v => updateLeg(leg.id, { strike: v })}/><NumField label="PREMIUM · 元/点" value={leg.premium} onChange={v => updateLeg(leg.id, { premium: v })}/><NumField label="QUANTITY · 张" value={leg.quantity} min={0.01} step={1} onChange={v => updateLeg(leg.id, { quantity: v })}/><NumField label="IV · %" value={leg.iv * 100} step={0.1} onChange={v => updateLeg(leg.id, { iv: v / 100 })}/></div>
          <div className="leg-fields leg-secondary"><label className="field"><span>EXPIRY / 到期日</span><input type="date" value={leg.expiry} onChange={e => updateLeg(leg.id, { expiry: e.target.value })}/></label><NumField label="MULTIPLIER · 元/点" value={leg.multiplier} onChange={v => updateLeg(leg.id, { multiplier: v })}/></div>
          <div className="leg-notional"><span>成交权利金金额</span><b className={leg.side === 'LONG' ? 'negative-text' : 'positive-text'}>{money((leg.side === 'LONG' ? -1 : 1) * leg.premium * leg.quantity * leg.multiplier)}</b></div>
          <div className={`manual-greeks ${state.greeksMode === 'MODEL' ? 'model-source' : ''}`}>
            <div className="greek-entry-heading"><strong>单份期权 Greeks</strong><span>{state.greeksMode === 'MANUAL' ? '正在用于组合汇总' : '当前汇总使用模型值'}</span></div>
            <div className="micro-caption">输入单份期权报价敏感度（未乘乘数）；Vega/Rho 按波动率/利率 1.00 输入，组合按张数与乘数折算为元值。</div>
            <div className="greek-input-grid">{greekKeys.map(k=><NumField key={k} label={`${k.toUpperCase()}`} value={leg.greeks[k] ?? ''} placeholder="输入（可为负）" min={-1e12} step={0.01} onChange={v => updateLeg(leg.id,{greeks:{...leg.greeks,[k]:v}})}/>)}</div>
          </div>
        </article>)}</div>}
        <div className="builder-footer"><span className="text-action greek-source-badge">GREEKS INPUT · {state.greeksMode}</span><span>{state.greeksMode === 'MANUAL' ? '逐腿输入后实时汇总' : '切换至 MODEL 使用定价模型'}</span></div>
        <div className="cost-box"><div className="section-title"><span>TRANSACTION COSTS</span><small>元 / 张</small></div><div className="cost-fields"><NumField label="开仓" value={state.costs.openPerContract} onChange={v => set('costs',{...state.costs,openPerContract:v})}/><NumField label="平仓" value={state.costs.closePerContract} onChange={v => set('costs',{...state.costs,closePerContract:v})}/><NumField label="到期结算" value={state.costs.settlementPerContract} onChange={v => set('costs',{...state.costs,settlementPerContract:v})}/></div></div>
        <div className="save-row"><input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder="命名当前组合"/><button title="保存组合" onClick={saveNamed} disabled={!state.legs.length || !saveName.trim()}><Save size={14}/></button></div>
        {saved.length > 0 && <div className="saved-list">{saved.map(item=><div className="saved-item" key={item.name}><button onClick={()=>setState(item.state)}>{item.name}</button><button title={`删除 ${item.name}`} onClick={()=>setSaved(saved.filter(x=>x.name!==item.name))}><X size={12}/></button></div>)}</div>}
      </aside>
      <section className="center-column">
        <section className="panel payoff-panel">
          <div className="panel-heading chart-heading"><div><span className="eyebrow">02 / EXPIRATION PROFILE</span><h2>PAYOFF ANALYSIS</h2></div><div className="chart-mode"><span className="status-square"/> {invalidInput?'INVALID INPUT':multiExpiry ? 'MULTI-EXPIRY STRUCTURE' : state.legs.length ? `EXPIRY · ${payoff.expiry}` : 'AWAITING LEGS'}</div></div>
          {invalidInput && <div className="notice-strip warning"><ShieldAlert size={14}/> 输入无效：执行价与权利金须为非负数，数量、乘数和 IV 须为正；修正后恢复分析。</div>}
          {multiExpiry && <div className="notice-strip warning"><ShieldAlert size={14}/> 多到期日组合无法用单一到期曲线表示。图表按各腿到期内在价值汇总，仅作结构参考；请使用统一估值日情景分析。</div>}
          <div className="metric-strip"><Metric label="NET PREMIUM" value={invalidInput?'N/A':state.legs.length ? money(payoff.netPremium) : 'N/A'} sub={invalidInput?'FIX INPUT':payoff.netDebit >= 0 ? `NET DEBIT · ${fmt(payoff.netDebit)} 元` : `NET CREDIT · ${fmt(-payoff.netDebit)} 元`} tone={payoff.netPremium < 0 ? 'loss' : 'gain'}/><Metric label="MAX PROFIT" value={invalidInput||multiExpiry?'N/A':showBound(payoff.maxProfit)} sub={invalidInput?'INVALID INPUT':multiExpiry?'MULTI-EXPIRY · USE SCENARIO':payoff.maxProfit === 'UNLIMITED' ? 'ASYMPTOTIC UPSIDE' : 'EXPIRATION VALUE'} tone="gain"/><Metric label="MAX LOSS" value={invalidInput||multiExpiry?'N/A':showBound(payoff.maxLoss)} sub={invalidInput?'INVALID INPUT':multiExpiry?'MULTI-EXPIRY · USE SCENARIO':payoff.maxLoss === 'UNLIMITED' ? 'ASYMPTOTIC DOWNSIDE' : 'EXPIRATION VALUE'} tone="loss"/><Metric label="BREAK-EVEN" value={invalidInput||multiExpiry?'N/A':payoff.breakEvens.length ? payoff.breakEvens.map(x=>fmt(x,1)).join('  /  ') : state.legs.length ? 'NONE' : 'N/A'} sub={`${payoff.breakEvens.length} ROOT${payoff.breakEvens.length===1?'':'S'} · 指数点`}/></div>
          <div className="chart-toolbar"><span><i className="legend-key portfolio"/> PORTFOLIO PNL <i className="legend-key spot"/> CURRENT SPOT</span><button className="text-action pnl-toggle" onClick={()=>setShowGross(!showGross)}>PNL · {showGross?'GROSS':'NET'} <ChevronDown size={13}/></button><button className="text-action" onClick={()=>setShowLegLines(!showLegLines)}>{showLegLines?'HIDE':'SHOW'} LEG CURVES <ChevronDown size={13}/></button><button className="text-action" onClick={exportPng}><Download size={13}/> EXPORT PNG</button><button className="text-action" onClick={()=>window.location.reload()}><RotateCcw size={13}/> RESET VIEW</button></div>
          <div className="payoff-plot">{validLegs.length && !invalidInput ? <Plot data={chartData} layout={layout} config={{ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d','autoScale2d'], toImageButtonOptions: { format: 'png', filename: 'options-payoff' } }} useResizeHandler style={{ width: '100%', height: '100%' }} /> : <div className="plot-empty"><div className="zero-label">0.00 元</div><div className="zero-line"/><div className="plot-hint"><Activity size={18}/><span>{invalidInput?'修正无效输入以恢复到期损益曲线':'添加期权腿以生成到期损益曲线'}</span><small>指数价格 ≥ 0 · 分段线性精确分析</small></div></div>}</div>
          <div className="chart-foot"><span>METHOD · EXACT PIECEWISE-LINEAR · {showGross?'GROSS':'NET'}</span><span>净值扣除开仓与结算费；不扣平仓费</span><span>EUROPEAN · CASH SETTLED</span></div>
        </section>
        <section className="panel scenario-panel">
          <div className="panel-heading"><div><span className="eyebrow">03 / FORWARD MARKING</span><h2>SCENARIO ANALYSIS</h2></div><button className="text-action" disabled={!state.legs.length} onClick={exportCsv}><Download size={13}/> EXPORT CSV</button></div>
          <div className="scenario-controls"><RangeControl label="UNDERLYING CHANGE" value={priceShift} min={-10} max={10} unit="%" onChange={v=>setPriceShift(v)}/><RangeControl label="PARALLEL IV SHIFT" value={ivShift} min={-10} max={10} unit="pp" onChange={v=>setIvShift(v)}/><RangeControl label="TIME FORWARD" value={Math.min(daysForward,maxScenarioDays)} min={0} max={maxScenarioDays} unit="天" onChange={v=>setDaysForward(v)}/><div className="scenario-readout"><span>SCENARIO PNL</span><b className={scenarioValue===null?'muted':scenarioValue>=0?'positive-text':'negative-text'}>{scenarioValue===null?(invalidInput?'INVALID INPUT':'INVALID IV'):money(scenarioValue)}</b><small>{fmt(spotMin)} 点 · IV {ivShift>0?'+':''}{fmt(ivShift)}pp · +{daysForward}d</small></div></div>
          {!modelValid && <div className="notice-strip warning"><ShieldAlert size={14}/> 输入无效：Spot、Forward、执行价和 IV 须为正；手续费须为非负数。IV 冲击后小于等于 0 的情景显示 N/A。</div>}
          <div className="scenario-visuals"><div className="scenario-heat"><div className="section-title"><span>PRICE × IV PNL MAP</span><small>单位：元 · 估值模型</small></div>{validLegs.length && modelValid ? <Plot data={[{ type:'heatmap', x:scenarioGrid.ps.map(p=>`${p.toFixed(0)}%`), y:scenarioGrid.vs.map(v=>`${v.toFixed(0)}pp`), z:scenarioGrid.z as number[][], colorscale:[[0,'#c87868'],[.5,'#f7f7f5'],[1,'#698d7d']], hovertemplate:'价格变动 %{x}<br>IV平移 %{y}<br>损益 %{z:,.2f} 元<extra></extra>', colorbar:{thickness:8,outlinewidth:0,tickfont:{size:9}} }]} layout={{ autosize:true,height:232,margin:{l:52,r:34,t:8,b:36},paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:'IBM Plex Mono, monospace',size:9,color:'#788084'},xaxis:{title:{text:'UNDERLYING MOVE'},gridcolor:'#e9ebea'},yaxis:{title:{text:'IV SHIFT'},gridcolor:'#e9ebea'} }} config={{responsive:true,displaylogo:false}} useResizeHandler style={{width:'100%',height:'100%'}}/> : <div className="heat-empty">{invalidInput?'修正无效输入以恢复情景网格':'添加期权腿后显示价格与波动率情景网格'}</div>}</div><div className="scenario-heat time-curve"><div className="section-title"><span>PNL BY REMAINING TIME</span><small>价格 ±10% · IV {ivShift>0?'+':''}{ivShift}pp</small></div>{validLegs.length && modelValid ? <Plot data={timeCurves.days.map((d,i)=>({type:'scatter',mode:'lines',x:timeCurves.priceMoves.map(p=>`${p.toFixed(1)}%`),y:timeCurves.pnl[i] as (number|null)[],name:`+${d}d`,line:{width:i===1?2:1.2,dash:i===0?'dot':'solid',color:['#a4acae','#3f484b','#ff7759'][i]},hovertemplate:`${d} 天后<br>标的变动 %{x}<br>损益 %{y:,.2f} 元<extra></extra>`}))} layout={{autosize:true,height:232,margin:{l:52,r:12,t:28,b:36},paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:'IBM Plex Mono, monospace',size:9,color:'#788084'},xaxis:{title:{text:'UNDERLYING MOVE'},gridcolor:'#e9ebea'},yaxis:{title:{text:'PNL · CNY'},gridcolor:'#e9ebea'},showlegend:true,legend:{orientation:'h',x:0,y:1.16,font:{size:8}}}} config={{responsive:true,displaylogo:false}} useResizeHandler style={{width:'100%',height:'100%'}}/> : <div className="heat-empty">添加期权腿后显示不同时间推进的损益曲线</div>}</div><div className="assumption-note"><div className="section-title"><span>MODEL SETTINGS</span><small>LOCAL ONLY</small></div><label>FORWARD / 远期点 <input type="number" step="1" value={state.forward} onChange={e=>set('forward',+e.target.value)}/></label><label>RISK-FREE RATE <input type="number" step="0.01" value={state.riskFreeRate} onChange={e=>set('riskFreeRate',+e.target.value)}/> <b>%</b></label><label>DIVIDEND YIELD <input type="number" step="0.01" value={state.dividendYield} onChange={e=>set('dividendYield',+e.target.value)}/> <b>%</b></label><div className="toggle-row"><span>GREEKS SOURCE</span><div className="segmented"><button className={state.greeksMode==='MANUAL'?'selected':''} onClick={()=>set('greeksMode','MANUAL')}>MANUAL</button><button className={state.greeksMode==='MODEL'?'selected':''} onClick={()=>set('greeksMode','MODEL')}>MODEL</button></div></div><small className="assumption-copy">{state.model==='BSM'?'BSM · Spot + dividend yield':'BLACK–76 · Forward quote; Delta 映射至 Spot'}。情景 PnL 以实际成交权利金为初始成本。</small></div></div>
          <div className="scenario-greeks"><div className="section-title"><span>SCENARIO GREEKS · {state.greeksMode}</span><small>局部风险 · 调整后参数</small></div>{greekKeys.map(k=><div key={k}><span>{greekLabels[k][0]}</span><b className={scenarioGreeks[k]===null?'muted':scenarioGreeks[k]!>=0?'positive-text':'negative-text'}>{scenarioGreeks[k]===null?'N/A':`${signed(scenarioGreeks[k]!)} ${greekLabels[k][1]}`}</b></div>)}</div>
          <div className="scenario-disclaimer">情景模型假设：统一估值日推进；IV 采用平行百分点平移并保留每腿初始 IV 差异。已到期腿按指数内在价值结算，浮动腿按所选定价模型估值。模型输出为理论变化，非可成交价格。</div>
        </section>
      </section>
      <aside className="panel inspector-panel">
        <div className="panel-heading"><div><span className="eyebrow">04 / STRUCTURE READOUT</span><h2>STRATEGY INSPECTOR</h2></div><BarChart3 size={16} className="muted-icon"/></div>
        <div className={`strategy-result ${strategy?'':'empty-result'}`}><span className="result-overline"><i/>{strategy?'STRUCTURE RECOGNIZED':'AWAITING STRUCTURE'}</span><h3>{strategy?.name ?? '— — —'}</h3><div className="strategy-cn">{strategy?.chinese ?? '添加期权腿以进行本地规则识别'}</div>{strategy && <div className="bias-tag">{strategy.bias} <span>·</span> {strategy.legs} LEGS</div>}</div>
        <div className="structure-facts"><div><span>PROFIT PROFILE</span><b>{invalidInput||multiExpiry?'N/A':payoff.maxProfit==='UNLIMITED'?'UNLIMITED':state.legs.length?'LIMITED':'N/A'}</b></div><div><span>LOSS PROFILE</span><b>{invalidInput||multiExpiry?'N/A':payoff.maxLoss==='UNLIMITED'?'UNLIMITED':state.legs.length?'LIMITED':'N/A'}</b></div><div><span>NET PREMIUM</span><b className={payoff.netDebit>0?'negative-text':'positive-text'}>{invalidInput?'N/A':state.legs.length?(payoff.netDebit>0?'DEBIT':'CREDIT'):'—'}</b></div><div><span>EXPIRY TYPE</span><b>{invalidInput?'N/A':multiExpiry?'MULTI':'SINGLE'}</b></div><div><span>RISK / REWARD</span><b>{invalidInput||multiExpiry?'N/A':payoff.maxProfit==='UNLIMITED'?'UNLIMITED':payoff.maxLoss==='UNLIMITED'?'0 / UNBOUNDED RISK':payoff.maxLoss===0?'N/A':fmt(payoff.maxProfit/Math.abs(payoff.maxLoss))}</b></div></div>
        <div className="greeks-section"><div className="section-title"><span>PORTFOLIO GREEKS</span><small>{state.greeksMode} MODE</small></div>{greekKeys.map(k=><div className="greek-row" key={k}><div className="greek-meta"><span>{greekLabels[k][0]}</span><b>{portfolioGreeks[k]===null?'N/A':`${signed(portfolioGreeks[k]!)} ${greekLabels[k][1]}`}</b></div><div className="greek-bar-track"><div className={`greek-bar ${portfolioGreeks[k]===null?'unknown':portfolioGreeks[k]!>=0?'up':'down'}`} style={{width:portfolioGreeks[k]===null?'0%':`${Math.max(6,Math.min(100,Math.abs(portfolioGreeks[k]!)/(k==='delta'?100:k==='gamma'?20:k==='theta'?300:k==='vega'?500:300)*100))}%`}}/></div></div>)}<p className="greek-explain">Delta 表示标的局部变动 1 点的理论价值变化。Greeks 是局部敏感度，不是全价格区间的固定收益率。</p><details className="leg-contributions" open><summary>LEG GREEK CONTRIBUTIONS · 元值</summary><div className="leg-greek-scroll"><div className="leg-greek-grid greek-table-head"><span>POSITION</span>{greekKeys.map(k=><span key={k} title={greekLabels[k][1]}>{k==='vega'?'VEGA':k.toUpperCase()}</span>)}</div>{state.legs.map((l,i)=><div className="leg-greek-grid" key={l.id}><span className="leg-greek-name">{String(i+1).padStart(2,'0')} · {l.side[0]} {l.optionType[0]} {fmt(l.strike,0)}</span>{greekKeys.map(k=><span key={k}>{greekRows[i]?.values[k]===null||greekRows[i]?.values[k]===undefined?'N/A':fmt(greekRows[i].values[k]!,1)}</span>)}</div>)}</div><small>列单位：Δ 元/点 · Γ 元/点² · Θ 元/天 · Vega 元/IV百分点 · Rho 元/利率百分点</small></details></div>
        <div className="risk-section"><div className="section-title"><span>RISK NOTES</span><small>RULE ENGINE</small></div>{riskNotes(strategy?.name ?? '', analysisLegs, payoff, portfolioGreeks, multiExpiry).map((note,i)=><div className="risk-note" key={i}><span>{String(i+1).padStart(2,'0')}</span><p>{note}</p></div>)}{state.legs.some(l=>l.side==='SHORT')&&<div className="margin-warning"><ShieldAlert size={13}/> MARGIN NOT CALCULATED <small>理论最大亏损不代表实际保证金</small></div>}</div>
        <div className="jurisdiction-note"><span>CN INDEX OPTIONS</span><p>欧式行权 · 现金交割。到期结算价不一定等于收盘价。损益分析不包含交易所保证金模型。</p></div>
      </aside>
    </div>
    {toast && <div className="strategy-toast"><div className="toast-icon"><Check size={15}/></div><div><span>STRATEGY DETECTED</span><b>{toast}</b><small>{strategy?.chinese}</small></div><button onClick={()=>setToast('')}><X size={14}/></button></div>}
    <footer className="app-footer"><span>OPTIONS WORKBENCH <i>v1.0</i></span><span>ALL COMPUTATION RUNS IN THIS BROWSER · NO MARKET FEED · NO ORDER ROUTING</span><span>EUROPEAN · CASH SETTLED · CNY</span></footer>
  </main>;
}

function showBound(v: number | 'UNLIMITED') { return v === 'UNLIMITED' ? 'UNLIMITED' : money(v); }
function NumField({ label, value, onChange, min=0, step=1, placeholder }: { label:string; value:number|string; onChange:(v:number)=>void; min?:number; step?:number; placeholder?:string }) { return <label className="field"><span>{label}</span><input type="number" min={min} step={step} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value===''?NaN:+e.target.value)}/></label>; }
function Metric({label,value,sub,tone}:{label:string;value:string;sub:string;tone?:string}) { return <div className="metric"><span>{label}</span><b className={tone==='gain'?'positive-text':tone==='loss'?'negative-text':''}>{value}</b><small>{sub}</small></div>; }
function RangeControl({label,value,min,max,unit,onChange}:{label:string;value:number;min:number;max:number;unit:string;onChange:(v:number)=>void}) { return <label className="range-control"><span>{label}<b>{value>0?'+':''}{value} {unit}</b></span><input type="range" min={min} max={max} step={unit==='天'?1:.5} value={value} onChange={e=>onChange(+e.target.value)}/><div><small>{min} {unit}</small><small>{max} {unit}</small></div></label>; }
function riskNotes(name:string, legs:OptionLeg[], payoff:ReturnType<typeof analyzePayoff>, greeks:GreekValues, multiExpiry=false):string[] {
  if (!legs.length) return ['自由搭建期权腿，工作台会根据结构自动归类。','识别仅依赖类型、方向、执行价、数量和到期日。'];
  const notes:string[]=[];
  if (name.includes('BULL CALL SPREAD')) notes.push('高执行价卖出 Call 限制上行收益；低执行价以下最大亏损为净支付权利金及费用。');
  else if (name.includes('BEAR CALL SPREAD')) notes.push('结构偏空，最大盈利受净收权利金限制；标的持续上涨时亏损有界。');
  else if (name.includes('STRADDLE') || name.includes('STRANGLE')) notes.push(name.startsWith('SHORT')?'短波动结构：上行理论亏损可能无限；指数下限为零，下行理论亏损有界。':'长波动结构需要足够大的价格变动覆盖初始权利金与费用。');
  else if (name.includes('IRON CONDOR')) notes.push(name.startsWith('SHORT')?'短铁鹰最大收益通常为净权利金；价格离开两侧短执行价后，尾部损失受保护腿限制。':'多头铁鹰承担净权利金成本，收益主要来自较大幅度的价格移动。');
  else if (name.includes('BUTTERFLY')) notes.push('蝶式对执行价附近的到期价格较敏感；中间执行价附近的 Gamma 暴露可能快速变化。');
  else if (name.includes('SPREAD')) notes.push('价差组合的盈亏边界由执行价间距与净权利金共同决定。');
  else if (name.includes('CALENDAR') || name.includes('DIAGONAL')) notes.push('跨期组合必须按统一估值日逐腿重估；短到期腿到期后按现金结算，不能继续当作存续期权。');
  else notes.push('自定义结构的方向性与尾部风险取决于全部腿的数量、方向和执行价。');
  notes.push(multiExpiry?'MULTI-EXPIRY：单一到期最大盈利、最大亏损和盈亏平衡点不适用；按统一估值日逐腿情景分析。':`TAIL / MAX LOSS：结构最大盈利 ${payoff.maxProfit==='UNLIMITED'?'无上界':`${fmt(payoff.maxProfit)} 元`}；最大亏损 ${payoff.maxLoss==='UNLIMITED'?'无下界':`${fmt(payoff.maxLoss)} 元`}。这是到期结构边界，不等同于保证金。`);
  const vega=greeks.vega, theta=greeks.theta, gamma=greeks.gamma;
  notes.push(`LOCAL EXPOSURE：Delta ${greeks.delta===null?'N/A':`${signed(greeks.delta)} 元/点`}；Gamma ${gamma===null?'N/A':`${signed(gamma)} 元/点²`}；Theta ${theta===null?'N/A':`${signed(theta)} 元/天`}；IV +1pp ${vega===null?'N/A':`${signed(vega)} 元`}。`);
  notes.push('到期前 Greeks 会随价格、时间和波动率变化；临近执行价时 Gamma 与结算价偏差风险可能上升。到期现金结算价不一定等于收盘价。');
  if (legs.some(l=>l.side==='SHORT')) notes.push('卖出期权组合的理论损失上界不能替代交易所保证金计算。');
  return notes.slice(0,5);
}
