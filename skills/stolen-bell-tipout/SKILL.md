---
name: stolen-bell-tipout
description: >
  Calculate Stolen Bell's end-of-day tip-out for a service day from Toast POS.
  Use when the GM says "run tip-out", "tip out for [date]", "calculate tips",
  "do the tip pool", or asks for a per-person payout sheet for a given day.
  Pulls card tips, food/net sales, and hours-by-role from Toast, splits Lunch
  vs Dinner, applies the pooling rules, and returns a payout sheet to review
  before anyone is paid. Read-only: never writes to Toast, payroll, or anywhere.
---

# Stolen Bell tip-out

Produces the per-person tip payout for one service day. The tip-out math lives in
`scripts/tipout.py` (deterministic, auditable); this skill's job is to pull the
right numbers from Toast, hand them to that engine, and present the result for a
human to approve. **Nothing here pays anyone or writes to any system.**

## The rules (applied per service period)

Two periods each day, split by clock time:
- **Lunch** 11:00–16:00
- **Dinner** 16:00–close

For each period:
- **Pool** = card tips collected in that period. Cash is not pooled unless the GM
  enters a cash figure for the period (it normally stays off).
- **Kitchen** = 10% of gross food sales → paid as a single lump; the Chef divides it.
- **Support** = % of net sales, split across the support staff (Host, Barback) by hours:
  **2.25%** if both a Host and a Barback worked, **1.5%** if only one support role worked,
  0% if neither did.
- **Remainder** = pool − kitchen − support → split across **Bartenders and Servers only**,
  by hours worked in that period.
- Kitchen and support are **obligations paid in full**. If card tips don't cover them
  (rare, only really possible once cash is involved), the engine reports a **due back**
  to settle from cash rather than scaling anyone down.

A person who works both periods gets their Lunch and Dinner amounts summed.

## Workflow

### 1. Establish the day and any cash
- Confirm the **business date** (default to yesterday if the GM doesn't say).
- Ask whether any **cash** is being added to either period's pool. Default: none.

### 2. Pull from Toast (read-only)
> ⚠ The Toast MCP tool names below are placeholders until our own Toast MCP server
> is live. Wire these to the real tool names once it exists; the shape of what's
> needed does not change.

Pull for the business date and bucket everything into Lunch / Dinner:
- **Card tips, timestamped** → each card tip falls into Lunch or Dinner by the time
  it was taken. Sum per period = `pool_card_tips`.
- **Sales by category, per period** → `gross_food_sales` (food-category items, pre-tax,
  after comps/discounts) and `net_sales` (all categories, pre-tax, after discounts).
- **Time entries (clock-in/clock-out) with job/role** → for each employee, compute hours
  **split at 16:00** (a shift crossing the boundary contributes to both periods; time
  before 11:00 counts toward neither). Map each person's Toast job to one of:
  `Bartender`, `Server`, `Host`, `Barback`, `Kitchen`. Keep a note of any Toast job
  title that doesn't map cleanly and surface it rather than guessing.

### 3. Assemble the input
Build JSON in the exact shape of `examples/dinner_example.json`: a `periods` object
with `Lunch` and/or `Dinner`, each carrying `pool_card_tips`, optional
`cash_tips_manual`, `gross_food_sales`, `net_sales`, and a `staff` list of
`{name, role, hours}`. Write it to the scratchpad.

### 4. Run the engine
```
python3 scripts/tipout.py <input.json>          # readable report
python3 scripts/tipout.py <input.json> --json    # structured, for building the sheet
```
The engine reconciles to the cent: every dollar of the card pool lands on a named
person, and kitchen comes out of sales as its own lump.

### 5. Present for approval
- Show the per-person day totals, the kitchen lump, and **every flag** the engine raised
  (due back, a $0 pool against real sales, an unmapped role, no bar/servers on a period).
- Build a per-person **payout sheet** (xlsx) from the `--json` output for the GM to keep.
- State plainly that this is a draft to review and that **no one is paid and nothing is
  written back** until the GM acts on it outside this skill.

## Guardrails
- **Read-only** against Toast. The Toast token should be scoped read-only so the skill
  physically cannot write; never call a write/update endpoint even if one is available.
- **Stop and ask** rather than guess if: a clock-out is missing (open shift), a Toast job
  doesn't map to a known role, food vs net sales can't be cleanly separated, or any period
  has sales but no tips.
- **Never** auto-push results to Rise, Xero, or Toast. The output is a sheet; a human pays.
- If the Toast pull fails or comes back empty, say so and stop. Do not estimate figures.
