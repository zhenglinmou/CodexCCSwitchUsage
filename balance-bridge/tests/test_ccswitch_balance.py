from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
PLUGIN = PROJECT / "plugins" / "ccswitch_balance.py"
SPEC = importlib.util.spec_from_file_location("ccswitch_balance_test", PLUGIN)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CcSwitchBalanceTests(unittest.TestCase):
    def test_acw_solver_known_vector(self) -> None:
        value = MODULE._solve_acw("A3F7266552617B54B8BE3AF29C125E502FABE903")
        self.assertEqual(len(value), 40)
        self.assertRegex(value, r"^[0-9a-f]{40}$")

    def test_success_preserves_unknown_balance_as_null(self) -> None:
        result = MODULE._success(
            {"id": "demo"},
            plan="Demo",
            remaining=None,
            used=1.25,
            total=None,
            unit="USD",
            balanceSupported=False,
        )
        self.assertTrue(result["success"])
        self.assertIsNone(result["data"]["remaining"])
        self.assertFalse(result["data"]["balanceSupported"])

    def test_wham_summary(self) -> None:
        summary = MODULE._wham_summary(
            {
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 27,
                        "limit_window_seconds": 18000,
                        "reset_after_seconds": 600,
                        "reset_at": 123,
                    },
                    "secondary_window": {
                        "used_percent": 10,
                        "limit_window_seconds": 604800,
                        "reset_after_seconds": 1200,
                        "reset_at": 456,
                    },
                },
                "credits": {"balance": 5},
            }
        )
        self.assertEqual(summary["remaining"], 73)
        self.assertEqual(summary["used"], 27)
        self.assertEqual(summary["credit_balance"], 5)
        self.assertEqual([item["label"] for item in summary["limits"]], ["5小时", "7天"])

    def test_configured_limits_support_arbitrary_windows(self) -> None:
        limits = MODULE._configured_limits(
            {
                "limit_windows": [
                    {
                        "id": "monthly",
                        "label": "自然月",
                        "window_seconds": 2592000,
                        "remaining_path": "quota.month.remaining",
                        "used_path": "quota.month.used",
                        "total_path": "quota.month.total",
                        "reset_at_path": "quota.month.reset_at",
                        "unit": "USD",
                    }
                ]
            },
            {"quota": {"month": {"remaining": 80, "used": 20, "total": 100, "reset_at": "next"}}},
        )
        self.assertEqual(limits[0]["id"], "monthly")
        self.assertEqual(limits[0]["remaining"], 80)
        self.assertEqual(limits[0]["resetAt"], "next")


if __name__ == "__main__":
    unittest.main()
