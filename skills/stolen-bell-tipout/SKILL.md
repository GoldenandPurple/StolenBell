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
- **Pool** = card tips + auto-gratuity collected in that period (both from Toast), plus the
  period's cash tips. Cash is pooled but not captured by Toast: the till is counted twice,
  at the 4:00 changeover (Lunch) and at close (Dinner). The GM gives the skill both counts
  (cash is always a manual entry); everything else comes from Toast.
- **Kitchen** = 10% of gross food sales → paid as a single lump; the Chef divides it.
- **Support** = % of net sales, split across the support staff (Host, Barback, Busser) by
  hours: **2.25%** if two or more different support roles worked (e.g. a Host and a Barback),
  **1.5%** if only one support role worked, 0% if none did.
- **Remainder** = pool − kitchen − support → split across **Bartenders and Servers only**,
  by hours worked in that period.
- Kitchen and support are **obligations paid in full**. If card tips don't cover them
  (rare, only really possible once cash is involved), the engine reports a **due back**
  to settle from cash rather than scaling anyone down.

A person who works both periods gets their Lunch and Dinner amounts summed.

## Workflow

### 1. Establish the day and the cash counts
- Confirm the **business date** (default to yesterday if the GM doesn't say).
- Ask for the **cash tip count for each period**: the till count at the 4:00 changeover
  (Lunch) and at close (Dinner). Toast doesn't have these. Don't assume zero; if there
  genuinely was no cash, the GM says 0.

### 2. Pull from Toast (read-only)
Call the Toast MCP server's **`get_tipout_inputs`** tool with the business date
(`date`, YYYY-MM-DD) and the two counts as `cashLunch` and `cashDinner`.
It does the bucketing for you:
- **Card tips and auto-gratuity** are the amounts Toast credited to each shift, which already
  include Toast's own adjustments (as on its Tip Summary). A shift that crosses 4:00 is split by
  time worked on each side. `details.tips` shows these alongside the same tips rebuilt from the
  day's checks; if the two differ, a `check` issue says so. Show it to the GM.
- **Sales** go to the period the order was opened in. `gross_food_sales` is the
  food-category items before discounts, as Toast reports gross sales; `net_sales` is all
  categories after discounts. Both are pre-tax.
  `cash_sales` (cash payments, excluding tips) is only for the Cash Out form.
- **Hours** come from clock-in/clock-out, split at the Lunch/Dinner boundary, with unpaid
  breaks removed. Time before Lunch starts counts toward neither period. Toast jobs are
  mapped to `Bartender`, `Server`, `Host`, `Barback`, `Busser` or `Kitchen` by `config/tipout.yaml`
  in the MCP server repo.

Read the result:
- **`ready: false`** means at least one issue has severity `stop` (a missing cash count,
  an open shift, a Toast job with no role mapping, tips or orders without a time, sales
  with no tips, no food category found). **Stop.** Show the GM those issues and wait.
  Don't estimate around them.
- Issues with severity `check` don't block. Show them to the GM alongside the result.
- `details` shows card tips by payment type, auto-gratuity, cash sales and sales by
  category per period. Use it to answer "where did this number come from?"

### 3. Save the input
`input` is already in the exact shape of `examples/dinner_example.json`. Write it unchanged
to the scratchpad (e.g. `tipout-YYYY-MM-DD.json`).

### 4. Run the engine
```
python3 scripts/tipout.py <input.json>          # readable report
python3 scripts/tipout.py <input.json> --json    # structured, for building the sheet
```
The engine reconciles to the cent: every dollar of the pool (card tips, auto-gratuity and
cash) lands on a named person or the kitchen lump.

### 5. Present for approval
- Show the per-person day totals, the kitchen lump, and **every flag** the engine raised
  (due back, a $0 pool against real sales, an unmapped role, no bar/servers on a period).
- Fill the **Cash Out form** (`forms/CashOut_Form.xlsx`, one sheet per service period) with:
  ```
  python3 scripts/fill_cashout.py <input.json> --out CashOut_YYYY-MM-DD.xlsx --completed-by "<GM name>"
  ```
  This fills the yellow cells so Steph gets the same worksheet she uses now, with the form's
  own formulas doing the arithmetic, including each period's hourly rate for bar/servers
  (remainder ÷ their hours). It first checks that those formulas will land on the engine's
  figures. If it exits with `problems` (more staff than the form has rows, or a due back),
  **no form is written**. Show the problems and
  give the GM the engine's payout table instead; don't fill the form by hand to force it.
  Support rows get each person's role (Host, Barback or Busser); the form sets the support
  rate from which roles worked.
- State plainly that this is a draft to review and that **no one is paid and nothing is
  written back** until the GM acts on it outside this skill.

## Guardrails
- **Read-only** against Toast. The Toast token should be scoped read-only so the skill
  physically cannot write; never call a write/update endpoint even if one is available.
- **Stop and ask** rather than guess if: a cash count is missing, a clock-out is missing (open shift), a Toast job
  doesn't map to a known role, food vs net sales can't be cleanly separated, or any period
  has sales but no tips.
- **Never** auto-push results to Rise, Xero, or Toast. The output is a sheet; a human pays.
- If the Toast pull fails or comes back empty, say so and stop. Do not estimate figures.
