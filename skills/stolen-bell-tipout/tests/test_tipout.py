"""Run with: python3 -m unittest discover skills/stolen-bell-tipout/tests"""
import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from tipout import compute_day, compute_period  # noqa: E402

D = Decimal


def period(staff, card=1000, food=0, net=0, cash=None):
    return {"pool_card_tips": card, "cash_tips_manual": cash,
            "gross_food_sales": food, "net_sales": net, "staff": staff}


def paid_out(day):
    return sum(day["per_person"].values(), D("0")) + day["kitchen_lump_total"]


class ExampleDay(unittest.TestCase):
    def test_example_matches_known_figures(self):
        doc = json.loads((HERE.parent / "examples" / "dinner_example.json").read_text())
        day = compute_day(doc)
        self.assertEqual(day["kitchen_lump_total"], D("630.00"))
        self.assertEqual(day["per_person"], {
            "Mara (Bartender)": D("634.73"), "Devon (Server)": D("497.61"),
            "Sam (Server)": D("306.91"), "Priya (Host)": D("175.75"), "Tomas (Barback)": D("95.00"),
        })
        self.assertEqual(paid_out(day), D("2340.00"))


class Rules(unittest.TestCase):
    def test_support_rate_depends_on_which_roles_worked(self):
        both = compute_period("Dinner", period([{"name": "H", "role": "Host", "hours": 4},
                                                {"name": "B", "role": "Barback", "hours": 4}], net=1000))
        one = compute_period("Dinner", period([{"name": "H", "role": "Host", "hours": 4}], net=1000))
        none = compute_period("Dinner", period([{"name": "S", "role": "Server", "hours": 4}], net=1000))
        self.assertEqual((both.support_total, one.support_total, none.support_total),
                         (D("22.50"), D("15.00"), D("0.00")))

    def test_runner_is_support(self):
        r = compute_period("Dinner", period([{"name": "R", "role": "Runner", "hours": 4},
                                             {"name": "H", "role": "Host", "hours": 4}], net=1000))
        self.assertEqual(r.support_total, D("22.50"))
        self.assertEqual(r.support_payouts, {"R": D("11.25"), "H": D("11.25")})

    def test_busser_is_support(self):
        host_busser = compute_period("Dinner", period([{"name": "H", "role": "Host", "hours": 4},
                                                       {"name": "U", "role": "Busser", "hours": 4}], net=1000))
        two_bussers = compute_period("Dinner", period([{"name": "U1", "role": "Busser", "hours": 4},
                                                       {"name": "U2", "role": "Busser", "hours": 2}], net=1000))
        self.assertEqual(host_busser.support_total, D("22.50"))
        self.assertEqual(two_bussers.support_total, D("15.00"))
        self.assertEqual(two_bussers.support_payouts, {"U1": D("10.00"), "U2": D("5.00")})

    def test_auto_gratuity_and_cash_are_pooled(self):
        p = period([{"name": "S", "role": "Server", "hours": 4}], card=100, cash=25)
        p["auto_gratuity"] = 40
        r = compute_period("Dinner", p)
        self.assertEqual(r.pool, D("165.00"))
        self.assertEqual(r.tipped_payouts, {"S": D("165.00")})

    def test_due_back_when_pool_cannot_cover_obligations(self):
        r = compute_period("Lunch", period([{"name": "S", "role": "Server", "hours": 5}], card=50, food=1000))
        self.assertEqual(r.due_back, D("50.00"))
        self.assertEqual(r.tipped_payouts, {})
        self.assertTrue(any("DUE BACK" in f for f in r.flags))

    def test_hourly_rate_is_remainder_per_bar_server_hour(self):
        r = compute_period("Dinner", period([{"name": "A", "role": "Server", "hours": 6},
                                             {"name": "B", "role": "Bartender", "hours": 4}], card=1000))
        self.assertEqual(r.hourly_rate, D("100.00"))
        self.assertEqual(compute_period("Dinner", period([], card=0)).hourly_rate, D("0.00"))

    def test_split_reconciles_to_the_cent(self):
        r = compute_period("Dinner", period([{"name": n, "role": "Server", "hours": 1} for n in "ABC"], card=100))
        self.assertEqual(sorted(r.tipped_payouts.values()), [D("33.33"), D("33.33"), D("33.34")])


class PeopleListedTwice(unittest.TestCase):
    def test_two_tipped_entries_for_one_person_are_combined(self):
        doc = {"periods": {"Dinner": period([
            {"name": "Sam", "role": "Bartender", "hours": 3},
            {"name": "Sam", "role": "Server", "hours": 3},
            {"name": "Ana", "role": "Server", "hours": 6}])}}
        day = compute_day(doc)
        self.assertEqual(day["per_person"], {"Sam": D("500.00"), "Ana": D("500.00")})

    def test_support_and_tipped_amounts_are_added_not_overwritten(self):
        doc = {"periods": {"Dinner": period([
            {"name": "Jo", "role": "Host", "hours": 2},
            {"name": "Jo", "role": "Server", "hours": 4}], card=500, net=1000)}}
        day = compute_day(doc)
        self.assertEqual(day["per_person"]["Jo"], D("500.00"))  # 15.00 support + 485.00 remainder
        self.assertEqual(paid_out(day), D("500.00"))


class Flags(unittest.TestCase):
    def test_unknown_role_is_flagged(self):
        r = compute_period("Dinner", period([{"name": "X", "role": "Sommelier", "hours": 4},
                                             {"name": "S", "role": "Server", "hours": 4}]))
        self.assertTrue(any("Sommelier" in f for f in r.flags))

    def test_sales_with_no_tips_is_flagged(self):
        r = compute_period("Dinner", period([{"name": "S", "role": "Server", "hours": 4}], card=0, net=500))
        self.assertTrue(any("$0" in f for f in r.flags))


if __name__ == "__main__":
    unittest.main()
