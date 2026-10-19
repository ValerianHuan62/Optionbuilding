import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api_server


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
        self.assertTrue(all(row["volume"] is None for row in data["underlying"]))
        sql = "\n".join(call.args[0] for call in query.call_args_list)
        self.assertIn("o.date <= '2024-01-02'", sql)
        self.assertIn("o.date='2024-01-02'", sql)
        self.assertNotIn("2024-01-03", sql)

    def test_research_rejects_date_not_in_database_catalog(self):
        with patch.object(api_server, "psql_json_rows", return_value=[{"ok": False}]):
            with self.assertRaises(LookupError):
                api_server.research("2024-01-03")


if __name__ == "__main__":
    unittest.main()
