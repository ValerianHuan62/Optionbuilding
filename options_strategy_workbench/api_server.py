from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import date
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
