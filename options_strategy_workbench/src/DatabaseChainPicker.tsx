import { useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import type { OptionContract, WorkbenchState } from './models/option';

type ProductDates = { code: string; label: string; dates: string[] };
export type DatabaseChain = {
  product: string;
  underlying: string;
  valuationDate: string;
  spot: number;
  modelSpot?: number | null;
  riskFreeRate: number | null;
  riskFreeRateByExpiry: Record<string, number | null>;
  pricingByExpiry?: Record<string,{dividendYield:number|null;qStatus:string;validPairs:number;selectedPairs:number;usedPairs:number;outliers:number;method:string}>;
  expiries: string[];
  rows: OptionContract[];
};
type Props = { underlying: string; onLoaded: (data: DatabaseChain) => boolean | void };
const codeFor = (value: string) => value.match(/^(HO|IO|MO)/)?.[1] ?? 'MO';

export default function DatabaseChainPicker({ underlying, onLoaded }: Props) {
  const [products, setProducts] = useState<ProductDates[]>([]);
  const [product, setProduct] = useState(codeFor(underlying));
  const [tradeDate, setTradeDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const available = useMemo(() => products.find(item => item.code === product), [products, product]);
  const years = useMemo(() => [...new Set((available?.dates ?? []).map(item => item.slice(0, 4)))].sort((a, b) => b.localeCompare(a)), [available]);
  const [selectedYear, selectedMonth, selectedDay] = tradeDate.split('-');
  const months = useMemo(() => [...new Set((available?.dates ?? []).filter(item => item.startsWith(`${selectedYear}-`)).map(item => item.slice(5, 7)))].sort((a, b) => b.localeCompare(a)), [available, selectedYear]);
  const days = useMemo(() => (available?.dates ?? []).filter(item => item.startsWith(`${selectedYear}-${selectedMonth}-`)).map(item => item.slice(8, 10)).sort((a, b) => b.localeCompare(a)), [available, selectedYear, selectedMonth]);

  useEffect(() => {
    let active = true;
    fetch('/api/db/catalog').then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '无法读取数据库目录');
      return body.products as ProductDates[];
    }).then(items => {
      if (!active) return;
      setProducts(items);
      const current = items.find(item => item.code === codeFor(underlying)) ?? items[0];
      if (current) {
        setProduct(current.code);
        setTradeDate(current.dates[0] ?? '');
        setMessage(`数据库已连接 · ${current.code} · ${current.dates.length} 个估值日`);
      } else setMessage('数据库中没有可用期权数据');
    }).catch(error => { if (active) setMessage(error instanceof Error ? error.message : '数据库连接失败'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const current = products.find(item => item.code === codeFor(underlying));
    if (current && current.code !== product) {
      setProduct(current.code);
      setTradeDate(current.dates[0] ?? '');
    }
  }, [underlying, products, product]);

  const load = async (nextProduct = product, nextDate = tradeDate) => {
    if (!nextProduct || !nextDate || busy) return;
    setBusy(true);
    setMessage(`正在读取 ${nextProduct} · ${nextDate}…`);
    try {
      const response = await fetch(`/api/db/chain?product=${encodeURIComponent(nextProduct)}&date=${encodeURIComponent(nextDate)}`);
      const body = await response.json() as DatabaseChain & { error?: string };
      if (!response.ok) throw new Error(body.error ?? '读取期权链失败');
      if (onLoaded(body) === false) { setMessage('已取消导入，当前数据未更改'); return; }
      localStorage.setItem('options-db-source-v1', JSON.stringify({ product: nextProduct, valuationDate: nextDate }));
      setMessage(`已载入 ${body.rows.length} 个合约 · ${body.expiries.length} 个到期日 · 指数 ${body.spot.toFixed(2)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '数据库读取失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="database-chain-picker" aria-label="PostgreSQL 期权链">
    <div className="database-picker-title"><Database size={15}/><b>POSTGRESQL</b><span>只读 · 本机数据库</span></div>
    <label>品种<select value={product} onChange={event => {
      const next = event.target.value;
      const firstDate = products.find(item => item.code === next)?.dates[0] ?? '';
      setProduct(next); setTradeDate(firstDate);
    }}>{products.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
    <label>估值日</label>
    <label className="database-date-part">年<select value={selectedYear ?? ''} onChange={event => {
      const year = event.target.value;
      const yearDates = (available?.dates ?? []).filter(item => item.startsWith(`${year}-`));
      setTradeDate(yearDates[0] ?? '');
    }}>{years.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="database-date-part">月<select value={selectedMonth ?? ''} onChange={event => {
      const month = event.target.value;
      const monthDates = (available?.dates ?? []).filter(item => item.startsWith(`${selectedYear}-${month}-`));
      setTradeDate(monthDates[0] ?? '');
    }}>{months.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="database-date-part">日<select value={selectedDay ?? ''} onChange={event => {
      const next = `${selectedYear}-${selectedMonth}-${event.target.value}`;
      setTradeDate(next); void load(product, next);
    }}>{days.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    <button type="button" disabled={busy || !tradeDate} onClick={() => void load()}><RefreshCw size={13}/>{busy ? '读取中' : '载入期权链'}</button>
    <small role="status">{message || (available ? `${available.dates.length} 个历史估值日` : '正在连接数据库…')}</small>
  </section>;
}

export function databaseLoadedSettings(data: DatabaseChain, state: WorkbenchState, expiry?: string) {
  const selectedExpiry = (expiry && data.expiries.includes(expiry) ? expiry : data.expiries[0]) ?? data.valuationDate;
  const utc = (value: string) => { const [year, month, day] = value.split('-').map(Number); return Date.UTC(year, month - 1, day); };
  return {
    underlying: data.underlying,
    valuationDate: data.valuationDate,
    spot: data.modelSpot ?? data.spot,
    expiry: selectedExpiry,
    multiplier: data.rows[0]?.multiplier ?? state.multiplier,
    riskFreeRate: data.riskFreeRateByExpiry[selectedExpiry] ?? data.riskFreeRate ?? state.riskFreeRate,
    dividendYield: data.pricingByExpiry?.[selectedExpiry]?.dividendYield == null ? state.dividendYield : data.pricingByExpiry[selectedExpiry].dividendYield! * 100,
    dividendYieldSource: data.pricingByExpiry?.[selectedExpiry]?.dividendYield == null ? 'UNSET' as const : 'DATABASE' as const,
    daysToExpiry: Math.max(0, (utc(selectedExpiry) - utc(data.valuationDate)) / 86400000),
    optionChain: data.rows,
  };
}
