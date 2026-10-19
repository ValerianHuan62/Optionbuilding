from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import csv
import time
from datetime import date
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


PRODUCT_LABELS = {
    "MO": "MO · 中证1000",
    "IO": "IO · 沪深300",
    "HO": "HO · 上证50",
}


def psql_json_rows(sql: str) -> list[dict]:
    psql = shutil.which("psql")
    if not psql:
        raise RuntimeError("未找到 psql，请先安装 PostgreSQL 命令行工具。")
    dsn = os.environ.get("OPTIONS_PG_DSN", "host=localhost port=5432 dbname=options")
    result = subprocess.run(
        [psql, dsn, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PGOPTIONS": "-c default_transaction_read_only=on"},
    )
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def catalog() -> dict:
    rows = psql_json_rows(
        """SELECT json_build_object('product', c.product, 'date', o.date::text)::text
           FROM (SELECT DISTINCT product FROM contracts) p
           JOIN contracts c USING (product)
           JOIN option_daily o USING (instrument_id)
           GROUP BY c.product, o.date
           ORDER BY c.product, o.date DESC"""
    )
    by_product: dict[str, set[str]] = {}
    for row in rows:
        by_product.setdefault(row["product"], set()).add(row["date"])
    return {
        "products": [
            {"code": product, "label": PRODUCT_LABELS.get(product, product), "dates": sorted(dates, reverse=True)}
            for product, dates in sorted(by_product.items())
        ]
    }


def chain(product: str, trade_date: str) -> dict:
    if not re.fullmatch(r"[A-Z]{2,4}", product) or product not in PRODUCT_LABELS:
        raise ValueError("不支持该期权品种。")
    try:
        parsed_date = date.fromisoformat(trade_date)
    except ValueError as exc:
        raise ValueError("估值日格式应为 YYYY-MM-DD。") from exc
    if parsed_date.isoformat() != trade_date:
        raise ValueError("估值日格式应为 YYYY-MM-DD。")

    rows = psql_json_rows(
        f"""SELECT json_build_object(
             'contractId', c.instrument_id,
             'underlying', '{PRODUCT_LABELS[product]}',
             'optionType', CASE c.option_type WHEN 'C' THEN 'CALL' ELSE 'PUT' END,
             'strike', c.strike,
             'expiry', c.expiry::text,
             'multiplier', c.multiplier,
             'premium', o.mid,
             'marketPremium', o.mid,
             'settlementPrice', o.settle,
             'bid', o.bid,
             'ask', o.ask,
             'last', o.last,
             'volume', o.volume,
             'openInterest', o.open_interest,
             'quoteStatus', o.quote_status,
             'quoteAt', CASE WHEN o.snapshot_time IS NULL THEN NULL ELSE o.date::text || ' ' || o.snapshot_time::text END,
             'ivAt', CASE WHEN g.iv IS NULL THEN NULL ELSE o.date::text END,
             'impliedVolatility', g.iv,
             'riskFreeRate', g.r * 100.0,
             'spot', m.index_close,
             'greeks', json_build_object(
               'delta', g.delta_f,
               'gamma', g.gamma_f,
               'theta', g.theta_f,
               'vega', g.vega,
               'rho', g.rho_f,
               'source', CASE WHEN g.iv IS NULL THEN NULL ELSE 'KUAIQI_RAW' END,
               'snapshotAt', CASE WHEN g.iv IS NULL THEN NULL ELSE o.date::text END
             )
           )::text
           FROM contracts c
           JOIN option_daily o ON o.instrument_id = c.instrument_id
           JOIN market_daily m ON m.date = o.date
           LEFT JOIN option_greeks_daily g ON g.date = o.date AND g.instrument_id = o.instrument_id
           WHERE c.product = '{product}' AND o.date = '{trade_date}'
           ORDER BY c.expiry, c.strike, c.option_type"""
    )
    if not rows:
        raise LookupError("所选估值日没有该品种的期权链数据。")
    expiries = sorted({row["expiry"] for row in rows})
    rate_by_expiry = {
        expiry: next((row["riskFreeRate"] for row in rows if row["expiry"] == expiry and row["riskFreeRate"] is not None), None)
        for expiry in expiries
    }
    return {
        "product": product,
        "underlying": PRODUCT_LABELS[product],
        "valuationDate": trade_date,
        "spot": rows[0]["spot"],
        "riskFreeRate": next((row["riskFreeRate"] for row in rows if row["riskFreeRate"] is not None), None),
        "riskFreeRateByExpiry": rate_by_expiry,
        "expiries": expiries,
        "rows": [
            {**row, "greeks": {key: value for key, value in row["greeks"].items() if value is not None}}
            for row in rows
        ],
    }


RESEARCH_CACHE: dict[str, tuple[float, dict]] = {}
RESEARCH_CACHE_TTL_SECONDS = 180
RESEARCH_METHOD_VERSION = "research-v1-bsm-spot-q-shibor-v1.0-default-filter-v1"
DEFAULT_RESEARCH_FILTERS = {"max_relative_spread": 0.5, "minimum_mid": 0.5, "minimum_dte": 3, "minimum_iv": 0.01, "maximum_iv": 5.0}


def research(trade_date: str, filters: dict | None = None) -> dict:
    """Historical market snapshot; every database result is explicitly capped at valuation date."""
    try:
        cutoff = date.fromisoformat(trade_date)
    except ValueError as exc:
        raise ValueError("估值日格式应为 YYYY-MM-DD。") from exc
    if cutoff.isoformat() != trade_date:
        raise ValueError("估值日格式应为 YYYY-MM-DD。")
    active_filters = {**DEFAULT_RESEARCH_FILTERS, **(filters or {})}
    for name, value in active_filters.items():
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} 必须是有限数值。")
    if not 0 <= active_filters["max_relative_spread"] <= 10 or active_filters["minimum_mid"] < 0 or not 1 <= active_filters["minimum_dte"] <= 3650 or not 0 < active_filters["minimum_iv"] < active_filters["maximum_iv"] <= 10:
        raise ValueError("报价质量筛选参数超出允许范围。")
    f = {key: format(value, ".12g") for key, value in active_filters.items()}
    cache_key = f"{trade_date}:{RESEARCH_METHOD_VERSION}:{tuple(sorted(f.items()))}"
    cached = RESEARCH_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < RESEARCH_CACHE_TTL_SECONDS:
        return cached[1]

    day_check = psql_json_rows(f"SELECT json_build_object('ok', EXISTS (SELECT 1 FROM market_daily WHERE date='{trade_date}') AND EXISTS (SELECT 1 FROM option_daily o JOIN contracts c USING(instrument_id) WHERE o.date='{trade_date}' AND c.product='MO'))::text")
    if not day_check or not day_check[0].get('ok'):
        raise LookupError("所选估值日不在数据库交易日目录中。")

    market_rows = [row for row in psql_json_rows(
        f"""SELECT json_build_object(
             'date', m.date::text, 'spot', m.index_close,
             'rates', json_build_array(m.shibor_on,m.shibor_1w,m.shibor_2w,m.shibor_1m,m.shibor_3m,m.shibor_6m,m.shibor_9m,m.shibor_1y)
           )::text FROM market_daily m WHERE m.date <= '{trade_date}' ORDER BY m.date"""
    ) if row.get('date') <= trade_date]
    expiry_history = psql_json_rows(
        f"""WITH valid AS (
             SELECT o.date, c.expiry, c.strike, c.option_type, g.iv, f.days_to_expiry AS dte,
                    f.forward, f.spot, f.r, f.quality, o.mid,
                    row_number() OVER (PARTITION BY o.date,c.expiry ORDER BY abs(c.strike-f.forward), c.strike, c.option_type) AS rank
             FROM option_daily o JOIN contracts c USING(instrument_id)
             JOIN option_greeks_daily g USING(date,instrument_id)
             JOIN forward_daily f ON f.date=o.date AND f.expiry=c.expiry
             WHERE o.date <= '{trade_date}' AND c.product='MO' AND f.forward > 0
               AND g.model_version='bsm-spot-q-shibor-v1.0'
               AND g.iv IS NOT NULL AND g.iv_status IN ('OK','NEAR_EXPIRY','LOW_VEGA')
               AND o.quote_status='OK' AND o.bid >= 0 AND o.ask > 0 AND o.bid <= o.ask
               AND f.days_to_expiry >= {f['minimum_dte']} AND o.mid >= {f['minimum_mid']}
               AND (o.ask-o.bid)/NULLIF(o.mid,0) <= {f['max_relative_spread']}
               AND g.iv BETWEEN {f['minimum_iv']} AND {f['maximum_iv']}
           ), nearest AS (
             SELECT DISTINCT ON(date,expiry) date,expiry,strike,dte,forward,spot,r,quality
             FROM valid ORDER BY date,expiry,rank
           ), atm AS (
             SELECT n.date,n.expiry,n.dte,n.forward,n.spot,n.r,n.quality,
                    avg(v.iv) FILTER (WHERE v.iv IS NOT NULL) AS atm_iv,
                    count(v.iv) AS valid_quotes
             FROM nearest n JOIN valid v ON v.date=n.date AND v.expiry=n.expiry AND v.strike=n.strike
             GROUP BY n.date,n.expiry,n.dte,n.forward,n.spot,n.r,n.quality
           )
           SELECT json_build_object('date',date::text,'expiry',expiry::text,'dte',dte,'forward',forward,'spot',spot,'r',r,
                    'q', CASE WHEN forward > 0 AND spot > 0 AND dte > 0 THEN r - ln(forward / spot) / (dte / 365.0) ELSE NULL END,
                    'quality',quality,'atmIv',atm_iv,'validQuotes',valid_quotes)::text
           FROM atm ORDER BY date,expiry"""
    )
    chain_rows = psql_json_rows(
        f"""SELECT json_build_object('contractId',c.instrument_id,'expiry',c.expiry::text,'optionType',c.option_type,
             'strike',c.strike,'multiplier',c.multiplier,'bid',o.bid,'ask',o.ask,'mid',o.mid,'last',o.last,'settle',o.settle,
             'volume',o.volume,'openInterest',o.open_interest,'quoteStatus',o.quote_status,
             'iv',CASE WHEN o.quote_status='OK' AND o.bid>=0 AND o.ask>0 AND o.bid<=o.ask AND o.mid >= {f['minimum_mid']}
                       AND (o.ask-o.bid)/NULLIF(o.mid,0) <= {f['max_relative_spread']}
                       AND g.iv BETWEEN {f['minimum_iv']} AND {f['maximum_iv']} AND f.days_to_expiry >= {f['minimum_dte']} THEN g.iv ELSE NULL END,
             'ivStatus',g.iv_status,'delta',g.delta_f,'gamma',g.gamma_f,'theta',g.theta_f,'vega',g.vega,'rho',g.rho_f,
             'forward',f.forward,'rate',g.r,'quality',f.quality)::text
           FROM option_daily o JOIN contracts c USING(instrument_id)
           LEFT JOIN option_greeks_daily g USING(date,instrument_id)
           LEFT JOIN forward_daily f ON f.date=o.date AND f.expiry=c.expiry
           WHERE o.date='{trade_date}' AND c.product='MO' ORDER BY c.expiry,c.strike,c.option_type"""
    )
    csv_path = Path(__file__).resolve().parent / "research_data" / "csi1000_daily.csv"
    underlying = []
    with csv_path.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if row["date"] > trade_date:
                break
            if row["date"] >= (market_rows[0]["date"] if market_rows else trade_date):
                underlying.append({"date": row["date"], "open": float(row["open"]), "high": float(row["high"]),
                                   "low": float(row["low"]), "close": float(row["close"]), "volume": None})
    data = {"valuationDate": trade_date, "cutoff": trade_date, "underlying": underlying,
            "market": market_rows, "expiries": expiry_history, "chain": chain_rows,
            "methodology": {"ivModel": "BSM", "ivSource": "option_greeks_daily · bsm-spot-q-shibor-v1.0",
                            "priceSource": "Database precomputed IV using stored price_used; bid/ask quality rechecked",
                            "forwardSource": "forward_daily ROBUST PUT-CALL PARITY", "rateSource": "same-date SHIBOR in market_daily",
                            "dayCount": "ACT/365", "minimumDte": active_filters["minimum_dte"],
                            "indexVolume": "DATA UNAVAILABLE · market_daily has no index volume field"},
            "qualityFilters": active_filters}
    if len(RESEARCH_CACHE) >= 24:
        RESEARCH_CACHE.pop(next(iter(RESEARCH_CACHE)))
    RESEARCH_CACHE[cache_key] = (time.monotonic(), data)
    return data


class Handler(BaseHTTPRequestHandler):
    server_version = "OptionsWorkbenchDB/1.0"

    def send_json(self, status: int, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        request = urlparse(self.path)
        query = parse_qs(request.query)
        try:
            if request.path == "/api/db/catalog":
                self.send_json(200, catalog())
                return
            if request.path == "/api/db/chain":
                product = query.get("product", [""])[0]
                trade_date = query.get("date", [""])[0]
                self.send_json(200, chain(product, trade_date))
                return
            if request.path == "/api/research":
                filters = {}
                for parameter, key in (("maxSpread", "max_relative_spread"), ("minMid", "minimum_mid"), ("minDte", "minimum_dte"), ("minIv", "minimum_iv"), ("maxIv", "maximum_iv")):
                    if parameter in query:
                        filters[key] = float(query[parameter][0])
                self.send_json(200, research(query.get("date", [""])[0], filters))
                return
            self.send_json(404, {"error": "API endpoint not found"})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except LookupError as exc:
            self.send_json(404, {"error": str(exc)})
        except (subprocess.SubprocessError, OSError, json.JSONDecodeError, RuntimeError) as exc:
            print(f"PostgreSQL read failed: {type(exc).__name__}", flush=True)
            self.send_json(503, {"error": "PostgreSQL 读取失败，请确认本机数据库、OPTIONS_PG_DSN 和数据表状态。"})

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    host = os.environ.get("OPTIONS_API_HOST", "127.0.0.1")
    port = int(os.environ.get("OPTIONS_API_PORT", "4174"))
    print(f"Options Workbench read-only PostgreSQL API at http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
