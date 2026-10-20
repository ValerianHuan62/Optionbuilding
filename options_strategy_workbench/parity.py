"""Shared quote validation and group dividend-yield estimator used by IV generation and API."""
from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date
from typing import Any


def optional_float(value: Any) -> float | None:
    if value in (None, "", r"\N"):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def valid_quote(row: dict[str, Any]) -> tuple[bool, float | None, str]:
    bid, ask = optional_float(row.get("bid")), optional_float(row.get("ask"))
    if bid is None or ask is None:
        return False, None, "MISSING_BID_OR_ASK"
    if bid < 0:
        return False, None, "NEGATIVE_BID"
    if ask <= 0:
        return False, None, "NONPOSITIVE_ASK"
    if ask < bid:
        return False, None, "CROSSED_QUOTE"
    mid = (bid + ask) / 2.0
    if mid <= 0:
        return False, None, "NONPOSITIVE_MID"
    return True, mid, "OK"


def estimate_group_q(rows: list[dict[str, Any]], spot: float, rate: float) -> tuple[float | None, dict[str, Any], list[dict[str, Any]]]:
    """Match prepare_greeks.py: nearest five valid parity pairs, median + 3 scaled MAD."""
    trade_date = date.fromisoformat(rows[0]["date"])
    expiry = date.fromisoformat(rows[0]["expiry"])
    dte = (expiry - trade_date).days
    if dte <= 0 or spot <= 0:
        return None, {"q_status": "NO_POSITIVE_T", "valid_pairs": 0, "selected_pairs": 0}, []
    t = dte / 365.0
    by_strike: dict[float, dict[str, tuple[float, dict[str, Any]]]] = defaultdict(dict)
    for row in rows:
        valid, mid, reason = valid_quote(row)
        row["_quote_valid"], row["_mid"], row["_quote_reason"] = valid, mid, reason
        option_type = row.get("option_type")
        if valid and option_type in ("C", "P"):
            by_strike[float(row["strike"])][option_type] = (float(mid), row)
    candidates = []
    for strike, pair in by_strike.items():
        if "C" not in pair or "P" not in pair:
            continue
        call_mid, call_row = pair["C"]
        put_mid, put_row = pair["P"]
        argument = (call_mid - put_mid + strike * math.exp(-rate * t)) / spot
        q_value = -math.log(argument) / t if argument > 0 and math.isfinite(argument) else None
        candidates.append({"strike": strike, "call_mid": call_mid, "put_mid": put_mid,
                           "q_pair": q_value if q_value is not None and math.isfinite(q_value) else None,
                           "call_row": call_row, "put_row": put_row})
    candidates.sort(key=lambda pair: (abs(pair["strike"] - spot), pair["strike"]))
    selected = candidates[:5]
    usable = [pair for pair in selected if pair["q_pair"] is not None]
    if not usable:
        return None, {"q_status": "NO_VALID_PARITY_PAIR", "valid_pairs": 0, "selected_pairs": len(selected)}, []
    values = [float(pair["q_pair"]) for pair in usable]
    median = statistics.median(values)
    mad = statistics.median(abs(value - median) for value in values)
    if len(values) >= 3:
        filtered = ([pair for pair in usable if abs(float(pair["q_pair"]) - median) <= 1e-10]
                    if mad == 0 else [pair for pair in usable if abs(float(pair["q_pair"]) - median) <= 3 * 1.4826 * mad])
    else:
        filtered = usable
    if not filtered:
        return None, {"q_status": "ALL_Q_OUTLIERS", "valid_pairs": len(usable), "selected_pairs": len(selected)}, []
    q_estimate = statistics.median(float(pair["q_pair"]) for pair in filtered)
    selected_strikes = {pair["strike"] for pair in selected}
    for pair in candidates:
        pair["selected_for_q"] = pair["strike"] in selected_strikes
    return q_estimate, {"q_status": "LOW_CONFIDENCE" if len(filtered) < 3 else "OK", "valid_pairs": len(usable),
                        "selected_pairs": len(selected), "used_pairs": len(filtered), "q_outliers": len(usable) - len(filtered), "q": q_estimate}, candidates
