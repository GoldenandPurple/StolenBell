#!/usr/bin/env python3
"""
Stolen Bell tip-out engine.

Deterministic, POS-agnostic. Takes already-bucketed per-period figures
(card tips, food/net sales, and staff hours by role) and returns a payout
breakdown. All sales/tip data is fetched upstream by the skill (Toast MCP);
this module does only the math so the rules live in one auditable place.

Rules (per service period, Lunch 11:00-16:00 and Dinner 16:00-close):
  pool       = card tips + auto-gratuity in the period + the period's cash till count
  kitchen    = 10% of gross food sales       -> single lump, Chef splits later
  support    = % of net sales, split across support staff (Host/Barback) by hours
                 2.25% if BOTH Host and Barback worked
                 1.50% if exactly ONE support role worked
                 0%    if neither worked
  remainder  = pool - kitchen - support       -> split across Bartenders/Servers by hours
  day total  = each person's Lunch + Dinner allocations summed
"""

from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP
from dataclasses import dataclass, field

CENT = Decimal("0.01")

TIPPED_ROLES = {"Bartender", "Server"}      # share the remainder
SUPPORT_ROLES = {"Host", "Barback"}         # share the support cut
# Kitchen: receives a lump, not allocated here.

KITCHEN_RATE = Decimal("0.10")
SUPPORT_RATE_ONE = Decimal("0.015")
SUPPORT_RATE_TWO = Decimal("0.0225")


def _money(x) -> Decimal:
    return Decimal(str(x)).quantize(CENT, rounding=ROUND_HALF_UP)


def _merge_by_name(people: list[dict]) -> list[dict]:
    hours: dict[str, Decimal] = {}
    for p in people:
        hours[p["name"]] = hours.get(p["name"], Decimal("0")) + Decimal(str(p["hours"]))
    return [{"name": n, "hours": h} for n, h in hours.items()]


def _add(into: dict[str, Decimal], payouts: dict[str, Decimal]) -> None:
    for name, amt in payouts.items():
        into[name] = into.get(name, Decimal("0.00")) + amt


def _split_by_hours(total: Decimal, people: list[dict]) -> dict[str, Decimal]:
    """Split `total` across people proportionate to hours, reconciled to the cent.

    Largest-remainder method so the parts sum EXACTLY to `total`. Someone listed
    more than once (e.g. two time entries) gets one share for their summed hours."""
    people = _merge_by_name(people)
    total_cents = int((total * 100).to_integral_value(rounding=ROUND_HALF_UP))
    hours = [Decimal(str(p["hours"])) for p in people]
    hsum = sum(hours)
    if hsum == 0 or total_cents == 0:
        return {p["name"]: Decimal("0.00") for p in people}

    raw = [Decimal(total_cents) * h / hsum for h in hours]
    base = [int(r.to_integral_value(rounding="ROUND_FLOOR")) for r in raw]
    remainder = total_cents - sum(base)
    # hand out leftover cents to the largest fractional parts
    frac_order = sorted(range(len(raw)), key=lambda i: raw[i] - base[i], reverse=True)
    for k in range(remainder):
        base[frac_order[k % len(base)]] += 1

    return {people[i]["name"]: (Decimal(base[i]) / 100) for i in range(len(people))}


@dataclass
class PeriodResult:
    period: str
    pool: Decimal
    kitchen: Decimal
    support_rate: Decimal
    support_total: Decimal
    remainder: Decimal
    support_payouts: dict
    tipped_payouts: dict
    due_back: Decimal = Decimal("0.00")
    flags: list = field(default_factory=list)


def compute_period(period: str, data: dict) -> PeriodResult:
    card = _money(data.get("pool_card_tips", 0))
    cash = data.get("cash_tips_manual")
    cash = _money(cash) if cash not in (None, "") else Decimal("0.00")
    auto_grat = _money(data.get("auto_gratuity", 0))
    pool = card + cash + auto_grat

    gross_food = _money(data.get("gross_food_sales", 0))
    net_sales = _money(data.get("net_sales", 0))
    staff = data.get("staff", [])

    unknown = sorted({s["role"] for s in staff} - TIPPED_ROLES - SUPPORT_ROLES - {"Kitchen"})
    tipped = [s for s in staff if s["role"] in TIPPED_ROLES and Decimal(str(s["hours"])) > 0]
    support = [s for s in staff if s["role"] in SUPPORT_ROLES and Decimal(str(s["hours"])) > 0]
    roles_present = {s["role"] for s in support}

    kitchen = _money(gross_food * KITCHEN_RATE)

    if len(roles_present) >= 2:
        s_rate = SUPPORT_RATE_TWO
    elif len(roles_present) == 1:
        s_rate = SUPPORT_RATE_ONE
    else:
        s_rate = Decimal("0")
    support_total = _money(net_sales * s_rate)

    flags = []
    if unknown:
        flags.append(f"Unknown role(s) {', '.join(unknown)} - those hours were left out. Map them to a known role.")
    # Kitchen and support are obligations, paid in full. The remainder is
    # whatever the pool has left for bar/servers. On card tips alone it is
    # reliably positive; a negative only arises once cash is in play, and
    # it is a DUE BACK to be settled, not a figure to scale down.
    remainder = pool - kitchen - support_total
    due_back = Decimal("0.00")
    if remainder < 0:
        due_back = -remainder
        flags.append(
            f"DUE BACK ${due_back}: card pool ${pool} does not cover kitchen "
            f"${kitchen} + support ${support_total}. Settle the shortfall from cash."
        )
    if pool == 0 and (gross_food > 0 or net_sales > 0):
        flags.append("Sales recorded but card tip pool is $0 - check the tips pull for this period.")
    if not tipped and remainder > 0:
        flags.append("No bartenders/servers with hours - remainder has no one to pay.")

    support_payouts = _split_by_hours(support_total, support) if support else {}
    tipped_payouts = _split_by_hours(remainder, tipped) if (tipped and remainder > 0) else {}

    return PeriodResult(
        period=period, pool=pool, kitchen=kitchen, support_rate=s_rate,
        support_total=support_total, remainder=remainder,
        support_payouts=support_payouts, tipped_payouts=tipped_payouts,
        due_back=due_back, flags=flags,
    )


def compute_day(doc: dict) -> dict:
    results = [compute_period(name, pdata) for name, pdata in doc.get("periods", {}).items()]
    per_person: dict[str, Decimal] = {}
    for r in results:
        _add(per_person, r.support_payouts)
        _add(per_person, r.tipped_payouts)
    kitchen_lump = sum((r.kitchen for r in results), Decimal("0.00"))
    return {"date": doc.get("business_date"), "periods": results,
            "per_person": per_person, "kitchen_lump_total": kitchen_lump}


def format_report(day: dict) -> str:
    lines = [f"TIP-OUT  {day['date']}", "=" * 52]
    for r in day["periods"]:
        lines += [
            "", f"[{r.period}]",
            f"  Pool (card+grat+cash)   ${r.pool:>10,.2f}",
            f"  Kitchen (10% food)      ${r.kitchen:>10,.2f}   -> lump, Chef splits",
            f"  {f'Support ({(r.support_rate * 100).normalize():f}% net)':<24}${r.support_total:>10,.2f}",
        ]
        if r.due_back > 0:
            lines.append(f"  Remainder (bar/servers) ${Decimal('0.00'):>10,.2f}   (DUE BACK ${r.due_back:,.2f})")
        else:
            lines.append(f"  Remainder (bar/servers) ${r.remainder:>10,.2f}")
        for n, a in r.support_payouts.items():
            lines.append(f"      {n:<20} ${a:>10,.2f}  (support)")
        for n, a in r.tipped_payouts.items():
            lines.append(f"      {n:<20} ${a:>10,.2f}")
        for f in r.flags:
            lines.append(f"  !! {f}")
    lines += ["", "-" * 52, "PER PERSON (day total, excl. kitchen lump):"]
    for n, a in sorted(day["per_person"].items(), key=lambda kv: kv[1], reverse=True):
        lines.append(f"  {n:<24} ${a:>10,.2f}")
    lines.append(f"  {'KITCHEN (lump, to Chef)':<24} ${day['kitchen_lump_total']:>10,.2f}")
    # reconciliation check
    paid = sum(day["per_person"].values(), Decimal("0.00")) + day["kitchen_lump_total"]
    pool_total = sum((r.pool for r in day["periods"]), Decimal("0.00"))
    lines += ["", f"  Check: paid out ${paid:,.2f} vs pool ${pool_total:,.2f} "
                  f"(+ kitchen from sales)  diff ${paid - pool_total:,.2f}"]
    return "\n".join(lines)


if __name__ == "__main__":
    import json, sys
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    as_json = "--json" in sys.argv
    doc = json.load(open(args[0]))
    day = compute_day(doc)
    if as_json:
        out = {
            "date": day["date"],
            "kitchen_lump_total": str(day["kitchen_lump_total"]),
            "per_person": {n: str(a) for n, a in day["per_person"].items()},
            "periods": [{
                "period": r.period, "pool": str(r.pool), "kitchen": str(r.kitchen),
                "support_rate": str(r.support_rate), "support_total": str(r.support_total),
                "remainder": str(max(r.remainder, Decimal('0.00'))), "due_back": str(r.due_back),
                "support_payouts": {n: str(a) for n, a in r.support_payouts.items()},
                "tipped_payouts": {n: str(a) for n, a in r.tipped_payouts.items()},
                "flags": r.flags,
            } for r in day["periods"]],
        }
        print(json.dumps(out, indent=2))
    else:
        print(format_report(day))
