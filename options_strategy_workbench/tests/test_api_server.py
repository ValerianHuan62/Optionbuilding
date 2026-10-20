import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api_server
from options_system.bsm import bsm_price


class ResearchEndpointTests(unittest.TestCase):
    def tearDown(self):
        api_server.RESEARCH_CACHE.clear()

    def test_research_query_and_csv_are_cut_off_at_valuation_date(self):
        market = [
            {"date": "2024-01-02", "spot": 5000.0, "rates": [None] * 8},
            {"date": "2024-01-03", "spot": 5100.0, "rates": [None] * 8},
        ]
        results = [[{"ok": True}], market, [], []]
        with patch.object(api_server, "psql_json_rows", side_effect=results) as query:
            data = api_server.research("2024-01-02")
        self.assertEqual(data["cutoff"], "2024-01-02")
        self.assertTrue(all(row["date"] <= "2024-01-02" for row in data["market"]))
        self.assertTrue(all(row["date"] <= "2024-01-02" for row in data["underlying"]))
        index_day = next(row for row in data["underlying"] if row["date"] == "2024-01-02")
        self.assertEqual(index_day["volume"], 12837767000)
        self.assertTrue(all(isinstance(row["volume"], int) for row in data["underlying"]))
        sql = "\n".join(call.args[0] for call in query.call_args_list)
        self.assertIn("o.date <= '2024-01-02'", sql)
        self.assertIn("o.date='2024-01-02'", sql)
        self.assertNotIn("2024-01-03", sql)

    def test_research_rejects_date_not_in_database_catalog(self):
        with patch.object(api_server, "psql_json_rows", return_value=[{"ok": False}]):
            with self.assertRaises(LookupError):
                api_server.research("2024-01-03")

    def test_chain_api_transmits_same_expiry_parity_q(self):
        day, expiry, spot, rate, q = "2025-01-02", "2026-01-02", 100.0, .025, .041
        rows = []
        for strike in (95.0, 100.0, 105.0):
            for option_type in ("C", "P"):
                mid = bsm_price(option_type, spot, strike, 1.0, rate, q, .22)
                rows.append({
                    "contractId": f"MO-{option_type}-{strike}", "underlying": "MO · 中证1000",
                    "optionType": "CALL" if option_type == "C" else "PUT", "strike": strike,
                    "expiry": expiry, "multiplier": 100, "premium": mid, "marketPremium": mid,
                    "settlementPrice": None, "bid": mid-.01, "ask": mid+.01, "last": None,
                    "volume": 0, "openInterest": 0, "quoteStatus": "OK", "quoteAt": day,
                    "ivAt": day, "impliedVolatility": .22, "riskFreeRate": rate*100,
                    "modelRate": rate, "modelTime": 1.0, "modelSpot": spot,
                    "option_type_source": option_type, "spot": spot,
                    "greeks": {"delta": .5, "gamma": .01, "theta": -.01, "vega": .1, "rho": .1},
                })
        with patch.object(api_server, "psql_json_rows", return_value=rows):
            data = api_server.chain("MO", day)
        self.assertAlmostEqual(data["pricingByExpiry"][expiry]["dividendYield"], q, places=10)
        self.assertEqual(data["rows"][0]["qStatus"], "OK")
        self.assertEqual(data["rows"][0]["dividendYield"], data["rows"][-1]["dividendYield"])


if __name__ == "__main__":
    unittest.main()
