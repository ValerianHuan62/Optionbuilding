"""Read-only export of an MO daily chain for the browser Strike Optimizer.

Usage (from mo_options_data_system): uv run python ../options_strategy_workbench/scripts/export_optimizer_chain.py --date YYYY-MM-DD --expiry YYYY-MM-DD --output /private/tmp/mo_chain.csv
The environment's OPTIONS_PG_DSN is used when present. No database rows are changed.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import date
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mo_options_data_system" / "src"))
from options_system.bsm import bsm_implied_vol


FIELDS = [
    "tradeDate", "underlying", "expiry", "spot", "riskFreeRate", "fixedDividendYield", "strike",
    *[f"{side}{field}" for side in ("call", "put") for field in (
        "ContractId", "Bid", "Ask", "Mid", "Last", "Volume", "OpenInterest",
        "QuoteStatus", "SettlementPrice", "IV")],
]

SQL = """
SELECT c.instrument_id, c.option_type, c.strike, c.expiry,
       o.bid, o.ask, o.mid, o.last, o.volume, o.open_interest,
       o.quote_status, o.settle, g.r,
       m.index_close AS spot
FROM contracts c
JOIN option_daily o ON o.instrument_id = c.instrument_id
JOIN market_daily m ON m.date = o.date
LEFT JOIN option_greeks_daily g ON g.date = o.date AND g.instrument_id = c.instrument_id
  AND g.model_version = 'bsm-spot-q-shibor-v1.0'
WHERE o.date = %s AND c.expiry = %s AND c.product = 'MO'
ORDER BY c.strike, c.option_type
"""


def export_chain(trade_date: date, expiry: date, output: Path, dsn: str | None = None) -> int:
    with psycopg.connect(dsn or os.environ.get("OPTIONS_PG_DSN", "host=localhost port=5432 dbname=options"), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(SQL, (trade_date, expiry))
            source = cur.fetchall()
    rows: dict[float, dict] = {}
    for item in source:
        strike = item["strike"]
        row = rows.setdefault(strike, {"tradeDate": trade_date.isoformat(), "underlying": "MO · 中证1000", "expiry": expiry.isoformat(), "spot": item["spot"], "riskFreeRate": None, "fixedDividendYield": 1.1, "strike": strike})
        side = "call" if item["option_type"] == "C" else "put"
        days_to_expiry = (expiry - trade_date).days
        fixed_iv = None
        if (item["mid"] is not None and item["spot"] is not None and item["r"] is not None
                and item["quote_status"] == "OK" and days_to_expiry > 0):
            fixed_iv, _status = bsm_implied_vol(
                item["option_type"], float(item["mid"]), float(item["spot"]), float(strike),
                days_to_expiry / 365.0, float(item["r"]), 0.011,
            )
        row.update({
            f"{side}ContractId": item["instrument_id"],
            f"{side}Bid": item["bid"], f"{side}Ask": item["ask"],
            f"{side}Mid": item["mid"], f"{side}Last": item["last"],
            f"{side}Volume": item["volume"], f"{side}OpenInterest": item["open_interest"],
            f"{side}QuoteStatus": item["quote_status"], f"{side}SettlementPrice": item["settle"],
            f"{side}IV": fixed_iv * 100 if fixed_iv is not None else None,
        })
        if item["r"] is not None:
            row["riskFreeRate"] = item["r"] * 100
    rate = next((row["riskFreeRate"] for row in rows.values() if row["riskFreeRate"] is not None), None)
    for row in rows.values():
        row["riskFreeRate"] = rate
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows.values())
    return len(source)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, required=True)
    parser.add_argument("--expiry", type=date.fromisoformat, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    count = export_chain(args.date, args.expiry, args.output)
    print(f"Exported {count} real MO contracts to {args.output}")
