import type { ActivePosition, GreekInput, GreekInputFormat, OptionContract, OptionLeg, WorkbenchState } from '../models/option';

export const contractIdFor = (underlying: string, expiry: string, optionType: OptionContract['optionType'], strike: number) =>
  JSON.stringify([underlying, expiry, optionType, strike]);

function toKuaiqiGreeks(raw: GreekInput, multiplier: number, format: GreekInputFormat, profile: WorkbenchState['greekRawProfile']): GreekInput {
  if (raw.source === 'KUAIQI_RAW') return raw;
  const oldFormat = format;
  const thetaScale = oldFormat === 'TONGHUASHUN_RAW' && profile?.thetaUnit === 'YEAR' ? 1 / 365 : 1;
  const vegaScale = oldFormat === 'TONGHUASHUN_RAW' && profile?.vegaUnit === 'IV_DECIMAL' ? 0.01 : oldFormat === 'LEGACY_POINTS' ? 0.01 : 1;
  const rhoScale = oldFormat === 'TONGHUASHUN_RAW' && profile?.rhoUnit === 'RATE_DECIMAL' ? 0.01 : oldFormat === 'LEGACY_POINTS' ? 0.01 : 1;
  const preApplied = oldFormat === 'TONGHUASHUN_RAW' && profile?.includesMultiplier;
  const factor = oldFormat === 'STANDARDIZED' ? 1 / multiplier : preApplied ? 1 / multiplier : 1;
  return {
    delta: raw.delta === undefined ? undefined : raw.delta * factor,
    gamma: raw.gamma === undefined ? undefined : raw.gamma * factor,
    theta: raw.theta === undefined ? undefined : raw.theta * factor * thetaScale,
    vega: raw.vega === undefined ? undefined : raw.vega * factor * vegaScale,
    rho: raw.rho === undefined ? undefined : raw.rho * factor * rhoScale,
    source: 'KUAIQI_RAW', snapshotAt: raw.snapshotAt,
  };
}

export function migrateWorkbenchState(raw: Partial<WorkbenchState> & { legs?: OptionLeg[] }, defaults: WorkbenchState): WorkbenchState {
  const next = { ...defaults, ...raw, costs: { ...defaults.costs, ...raw.costs } };
  // Older browser snapshots carried alternate pricing and manual-Greek settings.
  // Drop them on load so every saved strategy uses the same spot BSM path.
  const legacyState = raw as Partial<WorkbenchState> & { forward?: number; model?: string };
  if (legacyState.model === 'BLACK76' && !next.migrationNote) {
    if (Number.isFinite(legacyState.forward) && legacyState.forward! > 0) next.spot = legacyState.forward!;
    next.migrationNote = `旧模型当前组合：原现货 ${raw.spot ?? 'N/A'}，原远期 ${legacyState.forward ?? 'N/A'}；BSM 暂以原远期作为现货，请核对。`;
  }
  for (const key of ['forward', 'model', 'greeksMode']) delete (next as Record<string, unknown>)[key];
  const oldGreekFormat = raw.greekInputFormat ?? 'LEGACY_POINTS';
  const oldGreekProfile = raw.greekRawProfile ?? { thetaUnit: 'YEAR' as const, vegaUnit: 'IV_DECIMAL' as const, rhoUnit: 'RATE_DECIMAL' as const, includesMultiplier: false };
  const repairUnversionedQuick = raw.greekInputFormat === 'KUAIQI_RAW' && raw.greekUnitsVersion !== 1;
  const normalizeContractGreeks = (c: OptionContract) => {
    const greeks = toKuaiqiGreeks(c.greeks ?? {}, c.multiplier, oldGreekFormat, oldGreekProfile);
    if (!repairUnversionedQuick || c.greeks?.source !== 'KUAIQI_RAW') return { ...c, greeks };
    return { ...c, greeks: { ...greeks,
      delta: greeks.delta === undefined ? undefined : greeks.delta * 100,
      gamma: greeks.gamma === undefined ? undefined : greeks.gamma * 100,
      theta: greeks.theta === undefined ? undefined : greeks.theta * 100,
    } };
  };
  const savedStrategies = (raw.savedStrategies ?? []).map(record => {
    const pricingSettings = { ...record.pricingSettings };
    const legacyModel = (pricingSettings as { model?: string }).model;
    const legacyForward = (pricingSettings as { forward?: number }).forward;
    const legacySpot = pricingSettings.spot;
    let migrationNote = record.migrationNote;
    if (legacyModel === 'BLACK76' && !migrationNote) {
      if (Number.isFinite(legacyForward) && legacyForward! > 0) pricingSettings.spot = legacyForward!;
      migrationNote = `旧模型快照：原现货 ${legacySpot}，原远期 ${legacyForward ?? 'N/A'}；BSM 暂以原远期作为现货，请核对。`;
    }
    for (const key of ['forward', 'model', 'greeksMode', 'greekInputFormat', 'greekRawProfile']) delete (pricingSettings as Record<string, unknown>)[key];
    return { ...record, pricingSettings, ...(migrationNote ? { migrationNote } : {}) };
  });
  if (!Array.isArray(raw.legs) && Array.isArray(raw.optionChain) && Array.isArray(raw.activeStrategy)) {
    const chain = raw.optionChain.map(c => ({ ...normalizeContractGreeks(c), marketPremium: c.marketPremium ?? c.premium, settlementPrice: c.settlementPrice ?? null }));
    return { ...next, optionChain: chain, activeStrategy: raw.activeStrategy.map(p => ({ ...p, entryPremium: p.entryPremium ?? chain.find(c => c.contractId === p.contractId)?.premium ?? undefined })), legs: undefined,
      marginParams: raw.marginParams ?? defaults.marginParams, greekInputFormat: 'KUAIQI_RAW', greekRawProfile: defaults.greekRawProfile, greekUnitsVersion: 1, savedStrategies, activeSavedStrategyId: raw.activeSavedStrategyId ?? null };
  }
  const optionChain: OptionContract[] = [];
  const activeStrategy: ActivePosition[] = [];
  for (const leg of raw.legs ?? []) {
    const contractId = contractIdFor(next.underlying, leg.expiry, leg.optionType, leg.strike);
    if (!optionChain.some(contract => contract.contractId === contractId)) optionChain.push({
      contractId, underlying: next.underlying, optionType: leg.optionType, strike: leg.strike, expiry: leg.expiry,
      multiplier: leg.multiplier, premium: leg.premium, impliedVolatility: leg.iv, greeks: toKuaiqiGreeks(leg.greeks, leg.multiplier, oldGreekFormat, oldGreekProfile),
    });
    const position = activeStrategy.find(item => item.contractId === contractId && item.side === leg.side);
    if (position) position.quantity += leg.quantity;
    else activeStrategy.push({ contractId, side: leg.side, quantity: leg.quantity });
  }
  return { ...next, optionChain, activeStrategy, legs: undefined, greekInputFormat: 'KUAIQI_RAW', greekRawProfile: defaults.greekRawProfile, greekUnitsVersion: 1, savedStrategies };
}

export type ChainImportContext = { underlying: string; expiry: string; multiplier: number; greekInputFormat?: GreekInputFormat };
export type ChainImportPreview = { rows: OptionContract[]; errors: string[]; warnings?: string[]; expiry?: string; underlying?: string; valuationDate?: string; spot?: number; riskFreeRate?: number };
const headerAliases: Record<string, string> = {
  calliv: 'calliv', putiv: 'putiv', callimpliedvolatility: 'calliv', putimpliedvolatility: 'putiv',
  callpremium: 'callpremium', putpremium: 'putpremium', callprice: 'callpremium', putprice: 'putpremium',
  callmid: 'callpremium', putmid: 'putpremium',
  strike: 'strike', k: 'strike',
  callsettlementprice: 'callsettlementprice', putsettlementprice: 'putsettlementprice',
  callsettlement: 'callsettlementprice', putsettlement: 'putsettlementprice',
  callinstrumentid: 'callcontractid', putinstrumentid: 'putcontractid',
  callcode: 'callcontractid', putcode: 'putcontractid',
  calloi: 'callopeninterest', putoi: 'putopeninterest',
  callexchangevolume: 'callvolume', putexchangevolume: 'putvolume',
};
const normalizedHeader = (header: string) => {
  const key = header.trim().replace(/[ _-]/g, '').toLowerCase();
  const match = key.match(/^(call|put)(delta|gamma|theta|vega|rho)$/);
  return headerAliases[key] ?? (match ? `${match[1]}${match[2]}` : key);
};

function parseDelimited(text: string): string[][] {
  const delimiter = text.split(/\r?\n/, 1)[0]?.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) { row.push(cell.trim()); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); if (row.some(value => value !== '')) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim()); if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function parseTTable(table: string[][], context: ChainImportContext): ChainImportPreview | null {
  const headers = table[0];
  const strikeColumn = headers.findIndex(header => /行权价|执行价/.test(header));
  if (strikeColumn < 0) return null;

  const leftHeaders = headers.slice(0, strikeColumn), rightHeaders = headers.slice(strikeColumn + 1);
  const column = (side: 'CALL' | 'PUT', predicate: (header: string) => boolean) => {
    const source = side === 'CALL' ? leftHeaders : rightHeaders;
    const offset = side === 'CALL' ? 0 : strikeColumn + 1;
    const localIndex = source.findIndex(predicate);
    return localIndex < 0 ? -1 : offset + localIndex;
  };
  const greekColumn = (side: 'CALL' | 'PUT', greek: string) => column(side, header => header.trim().toLowerCase() === greek);
  const midPriceColumn = (side: 'CALL' | 'PUT') => column(side, header => /中间价|中间价格/.test(header));
  const bidColumn = (side: 'CALL' | 'PUT') => column(side, header => /买一价|买价|^bid$/i.test(header));
  const askColumn = (side: 'CALL' | 'PUT') => column(side, header => /卖一价|卖价|^ask$/i.test(header));
  const lastColumn = (side: 'CALL' | 'PUT') => column(side, header => /最新价|^last$/i.test(header));
  const volumeColumn = (side: 'CALL' | 'PUT') => column(side, header => /成交量|^volume$/i.test(header));
  const oiColumn = (side: 'CALL' | 'PUT') => column(side, header => /持仓量|^oi$|^open.interest$/i.test(header));
  const callMid = midPriceColumn('CALL'), putMid = midPriceColumn('PUT');
  const callPriceColumn = callMid, putPriceColumn = putMid;
  // The T-table also contains historical volatility, which is not option IV.
  const impliedVolatilityHeader = (header: string) => /隐含波动率|^\s*iv\s*$/i.test(header);
  const callIvColumn = column('CALL', impliedVolatilityHeader);
  const putIvColumn = column('PUT', impliedVolatilityHeader);
  if (callPriceColumn < 0 || putPriceColumn < 0) {
    return { rows: [], errors: ['T 字表必须同时包含 Call 与 Put 的“中间价”列；“最新价”不会作为期权价格导入。'] };
  }

  const code = headers[strikeColumn].match(/\b(IO|MO|HO)\d{4}\b/i)?.[1]?.toUpperCase();
  const underlying = code === 'IO' ? 'IO · 沪深300' : code === 'MO' ? 'MO · 中证1000' : code === 'HO' ? 'HO · 上证50' : context.underlying;
  const dateColumns = headers.flatMap((header, index) => /最后交易日|到期日|expiry/i.test(header) ? [index] : []);
  const errors: string[] = [], warnings: string[] = [], contracts: OptionContract[] = [], expiryValues = new Set<string>();
  let zeroIvCount = 0;
  const numberAt = (cells: string[], index: number, percent = false): number | null => {
    if (index < 0) return null;
    const raw = cells[index]?.trim();
    if (!raw || /^[-—–]$/.test(raw)) return null;
    const hasPercent = raw.endsWith('%');
    const value = Number(raw.replace(/[% ,]/g, ''));
    if (!Number.isFinite(value)) return Number.NaN;
    return hasPercent || (percent && value > 1) ? value / 100 : value;
  };
  const parseExpiry = (value: string | undefined) => {
    const match = value?.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  };
  const snapshotAt = new Date().toISOString();

  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const center = cells[strikeColumn]?.trim() ?? '';
    const strikeToken = center.match(/\bC(?:ALL)?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
      ?? center.match(/[\d,]+(?:\.\d+)?/g)?.at(-1);
    const strike = strikeToken ? Number(strikeToken.replaceAll(',', '')) : Number.NaN;
    if (!Number.isFinite(strike) || strike <= 0) { errors.push(`第 ${line} 行：无法从执行价中列解析执行价。`); return; }

    const expiryIndex = dateColumns.find(i => i < strikeColumn) ?? dateColumns.find(i => i > strikeColumn) ?? -1;
    const rowExpiry = parseExpiry(expiryIndex >= 0 ? cells[expiryIndex] : undefined) ?? context.expiry;
    expiryValues.add(rowExpiry);
    (['CALL', 'PUT'] as const).forEach(type => {
      const side = type === 'CALL' ? 'CALL' : 'PUT';
      const price = numberAt(cells, side === 'CALL' ? callPriceColumn : putPriceColumn);
      const bid = numberAt(cells, bidColumn(side)), ask = numberAt(cells, askColumn(side));
      const last = numberAt(cells, lastColumn(side)), volume = numberAt(cells, volumeColumn(side)), openInterest = numberAt(cells, oiColumn(side));
      const ivIndex = side === 'CALL' ? callIvColumn : putIvColumn;
      const rawIv = numberAt(cells, ivIndex, true);
      if (price !== null && (!Number.isFinite(price) || price < 0)) { errors.push(`第 ${line} 行 ${side}：中间价不是有效的非负数。`); return; }
      if ([bid,ask,last,volume,openInterest].some(v=>v!==null&&(!Number.isFinite(v)||v<0))) { errors.push(`第 ${line} 行 ${side}：报价或成交数据无效。`); return; }
      if (rawIv !== null && (!Number.isFinite(rawIv) || rawIv < 0)) { errors.push(`第 ${line} 行 ${side}：IV 不是有效的非负数。`); return; }
      const iv = rawIv === 0 ? null : rawIv;
      if (rawIv === 0) zeroIvCount++;
      const greeks: GreekInput = {};
      (['delta', 'gamma', 'theta', 'vega', 'rho'] as const).forEach(key => {
        const value = numberAt(cells, greekColumn(side, key));
        if (value !== null && Number.isFinite(value)) greeks[key] = value;
        else if (value !== null) errors.push(`第 ${line} 行 ${side} ${key} 不是有效数字。`);
      });
      const hasGreekValues = Object.values(greeks).some(value => value !== undefined);
      const contractId = contractIdFor(underlying, rowExpiry, type, strike);
      contracts.push({ contractId, underlying, optionType: type, strike, expiry: rowExpiry, multiplier: context.multiplier,
        premium: price, marketPremium: price, settlementPrice: null, bid, ask, last, volume, openInterest, impliedVolatility: iv,
        greeks: hasGreekValues ? { ...greeks, source: 'KUAIQI_RAW', snapshotAt } : greeks });
    });
  });
  if (expiryValues.size > 1) errors.push('T 字表中包含多个最后交易日，无法作为单一期权系列导入。');
  if (zeroIvCount) warnings.push(`${zeroIvCount} 个合约的 IV 显示为 0，按缺失值 N/A 导入；之后上传有效 IV 可更新。`);
  return { rows: contracts, errors, warnings, expiry: expiryValues.values().next().value, underlying };
}

export function parseOptionChainText(text: string, context: ChainImportContext): ChainImportPreview {
  const table = parseDelimited(text.replace(/^\uFEFF/, ''));
  if (table.length < 2) return { rows: [], errors: ['请粘贴至少包含表头和一行数据的 CSV / TSV。'] };
  const tTablePreview = parseTTable(table, context);
  if (tTablePreview) return tTablePreview;
  const headers = table[0].map(normalizedHeader), strikeColumn = headers.indexOf('strike');
  if (strikeColumn < 0) return { rows: [], errors: ['缺少必需列 strike。'] };
  const errors: string[] = [], warnings: string[] = [], contracts: OptionContract[] = [];
  let zeroIvCount = 0;
  const snapshotAt = new Date().toISOString();
  const numberAt = (cells: string[], name: string): number | null => {
    const idx = headers.indexOf(name), value = idx < 0 ? '' : cells[idx]?.trim();
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  };
  table.slice(1).forEach((cells, index) => {
    const line = index + 2, strike = numberAt(cells, 'strike');
    if (strike === null || !Number.isFinite(strike) || strike <= 0) { errors.push(`第 ${line} 行：strike 必须是正数。`); return; }
    (['CALL', 'PUT'] as const).forEach(type => {
      const side = type === 'CALL' ? 'call' : 'put';
      const premium = numberAt(cells, `${side}premium`), ivPercent = numberAt(cells, `${side}iv`), parsedIv = ivPercent === null ? null : ivPercent / 100;
      const iv = parsedIv === 0 ? null : parsedIv;
      const settlementPrice = numberAt(cells, `${side}settlementprice`);
      const bid = numberAt(cells, `${side}bid`), ask = numberAt(cells, `${side}ask`);
      const last = numberAt(cells, `${side}last`), volume = numberAt(cells, `${side}volume`);
      const openInterest = numberAt(cells, `${side}openinterest`);
      const idColumn = headers.indexOf(`${side}contractid`);
      const sourceContractId = idColumn < 0 ? null : cells[idColumn]?.trim();
      if (idColumn >= 0 && !sourceContractId) return;
      if (idColumn < 0 && premium === null && bid === null && ask === null && parsedIv === null) return;
      if (premium !== null && (!Number.isFinite(premium) || premium < 0)) { errors.push(`第 ${line} 行 ${type}：权利金不是有效的非负数。`); return; }
      if (settlementPrice !== null && (!Number.isFinite(settlementPrice) || settlementPrice < 0)) { errors.push(`第 ${line} 行 ${type}：结算价不是有效的非负数。`); return; }
      if ([bid,ask,last,volume,openInterest].some(v=>v!==null&&(!Number.isFinite(v)||v<0))) { errors.push(`第 ${line} 行 ${type}：报价或成交数据无效。`); return; }
      if (parsedIv !== null && (!Number.isFinite(parsedIv) || parsedIv < 0)) { errors.push(`第 ${line} 行 ${type}：IV 不是有效的非负数。`); return; }
      if (parsedIv === 0) zeroIvCount++;
      const greeks: GreekInput = {};
      (['delta', 'gamma', 'theta', 'vega', 'rho'] as const).forEach(key => {
        const value = numberAt(cells, `${side}${key}`);
        if (value !== null && Number.isFinite(value)) greeks[key] = context.greekInputFormat === 'LEGACY_POINTS' && (key === 'vega' || key === 'rho') ? value * 100 : value;
        else if (value !== null) errors.push(`第 ${line} 行 ${type} ${key} 不是有效数字。`);
      });
      const hasGreekValues=Object.values(greeks).some(value=>value!==undefined);
      const rowExpiry = headers.includes('expiry') ? cells[headers.indexOf('expiry')]?.trim() || context.expiry : context.expiry;
      const underlying = headers.includes('underlying') ? cells[headers.indexOf('underlying')]?.trim() || context.underlying : context.underlying;
      contracts.push({ contractId: sourceContractId || contractIdFor(underlying, rowExpiry, type, strike), underlying,
        optionType: type, strike, expiry: rowExpiry, multiplier: context.multiplier, premium:premium ?? (bid!==null&&ask!==null?(bid+ask)/2:null), marketPremium:premium ?? (bid!==null&&ask!==null?(bid+ask)/2:null), settlementPrice,
        bid,ask,last,volume,openInterest,quoteStatus: headers.includes(`${side}quotestatus`) ? cells[headers.indexOf(`${side}quotestatus`)]?.trim() : null,
        impliedVolatility: iv, greeks: hasGreekValues ? { ...greeks, source: context.greekInputFormat ?? 'KUAIQI_RAW', snapshotAt } : greeks });
    });
  });
  if (zeroIvCount) warnings.push(`${zeroIvCount} 个合约的 IV 显示为 0，按缺失值 N/A 导入；之后上传有效 IV 可更新。`);
  const first = table[1], firstNumber = (name:string) => { const value=first[headers.indexOf(name)]; const n=Number(value); return value&&Number.isFinite(n)?n:undefined; };
  return { rows: contracts, errors, warnings,
    expiry: headers.includes('expiry')?first[headers.indexOf('expiry')]?.trim():undefined,
    underlying: headers.includes('underlying')?first[headers.indexOf('underlying')]?.trim():undefined,
    valuationDate: headers.includes('tradedate')?first[headers.indexOf('tradedate')]?.trim():undefined,
    spot:firstNumber('spot'),riskFreeRate:firstNumber('riskfreerate') };
}

export function legsFromChain(chain: OptionContract[], positions: ActivePosition[]): OptionLeg[] {
  const byId = new Map(chain.map(contract => [contract.contractId, contract]));
  return positions.flatMap(position => {
    const contract = byId.get(position.contractId);
    if (!contract || (contract.premium === null && position.entryPremium === undefined)) return [];
    const premium = position.entryPremium ?? contract.premium;
    if (premium === null) return [];
    return [{ id: `${position.contractId}:${position.side}`, optionType: contract.optionType, side: position.side, strike: contract.strike,
      premium, quantity: position.quantity, multiplier: contract.multiplier, expiry: contract.expiry,
      iv: contract.impliedVolatility ?? Number.NaN, greeks: contract.greeks }];
  });
}

export function savedPositionsToLegs(chain: OptionContract[], positions: { contractId:string; side:'LONG'|'SHORT'; quantity:number; entryPremium:number }[]): OptionLeg[] {
  return positions.flatMap(position => {
    const contract = chain.find(c => c.contractId === position.contractId);
    if (!contract) return [];
    return [{ id: contract.contractId, optionType: contract.optionType, side: position.side, strike: contract.strike, premium: position.entryPremium,
      quantity: position.quantity, multiplier: contract.multiplier, expiry: contract.expiry, iv: contract.impliedVolatility ?? Number.NaN, greeks: contract.greeks }];
  });
}
