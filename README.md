# Toast staff MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that sits on top of the Toast POS API, so staff and managers can ask an AI assistant (Claude Desktop, Claude Code, or any MCP client) things like:

- "Run tip-out for yesterday." (with the Stolen Bell tip-out skill)
- "Sales by server for Friday and Saturday."
- "Who's still clocked in?" / "Hours by job this pay period."

It only reads from Toast. It never changes anything in Toast or payroll.

**Setting up the GM's computer?** Follow the [Windows setup guide](docs/SETUP-WINDOWS.md).

## Quick start (demo data, no Toast account needed)

```bash
npm install
npm run build
npm start          # demo mode by default
npm test
```

Add it to an MCP client, e.g. Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toast": {
      "command": "node",
      "args": ["/absolute/path/to/StolenBell/dist/index.js"],
      "env": { "TOAST_MCP_MODE": "demo" }
    }
  }
}
```

Demo mode serves a made-up restaurant shaped like Stolen Bell: lunch and dinner service with bartenders, servers, hosts, a barback on weekends, and a kitchen. Every response is labelled as demo data.

## Tools

| Tool | What it does |
| --- | --- |
| `get_restaurant_setup` | Restaurant info, job titles, sales categories, revenue centers, and how jobs map onto tip-out roles (including any job not yet mapped). |
| `list_staff` | Employees and the jobs they can clock in as. Returns no wages or contact details. |
| `sales_report` | Net sales, discounts, tax, tips, gratuities, guests and checks, by `total`, `day`, `server`, `revenue_center` or `sales_category`. |
| `top_items` | Best-selling menu items by net sales. |
| `labor_report` | Regular and overtime hours and shift counts by employee, job or day, plus who is still clocked in. |
| `tips_report` | Tips per employee and job before tip-outs: card tips, declared cash tips and auto-gratuities, plus tips per hour. |
| `get_tipout_inputs` | Everything the Stolen Bell tip-out needs for one day, split into Lunch and Dinner, plus a list of problems that must be fixed before paying anyone. Does not calculate payouts. |

Dates are Toast business dates (`YYYY-MM-DD`). A range can be up to 31 days.

## Tip-out

The tip-out is split between two pieces so the rules live in exactly one place:

1. **This server's `get_tipout_inputs` tool** pulls the day from Toast and buckets it into Lunch and Dinner.
2. **The [Stolen Bell tip-out skill](skills/stolen-bell-tipout/SKILL.md)** feeds that into its engine, [`scripts/tipout.py`](skills/stolen-bell-tipout/scripts/tipout.py), which applies the house rules: a pool of card tips, auto-gratuity and the counted cash, 10% of food sales to the kitchen, 2.25% / 1.5% of net sales to support staff (Host, Barback, Busser, Runner), and the remainder to Bartenders and Servers by hours. The skill then shows the GM a draft to approve and fills Steph's Cash Out form with [`scripts/fill_cashout.py`](skills/stolen-bell-tipout/scripts/fill_cashout.py). That script won't write a form whose formulas would disagree with the engine.

To change the **rules**, edit `tipout.py` (and its tests). To change how **Toast data is mapped**, edit [`config/tipout.yaml`](config/tipout.yaml):

| Setting | Meaning |
| --- | --- |
| `periods.lunchStart`, `periods.dinnerStart` | Lunch runs 11:00–16:00 and Dinner 16:00–close, in restaurant local time. After midnight still counts as Dinner. Hours before 11:00 count toward neither period. |
| `foodCategories` | Toast sales categories that count as food for the kitchen's share. |
| `roles` | Toast job title → `Bartender`, `Server`, `Host`, `Barback`, `Busser`, `Runner`, `Kitchen`, or `ignore`. |
| `otherJobs` | What happens to a job not listed under `roles`: a role (Stolen Bell uses `Server`, so it shares the bar/server remainder), `ignore`, or `stop` the run. Jobs handled this way are named in a `check` issue on each run. |
| `timeZone` | Optional override if Toast doesn't return the restaurant's time zone. |

How `get_tipout_inputs` buckets the day:

- **Card tips and auto-gratuity**: by default (`cardTipSource: time_entries`), the card tips and non-cash gratuity Toast credited to each shift. That is Toast's own allocation, so it matches its Tip Summary. A shift that crosses into the next period is split by time worked on each side. Tips on every shift count, including jobs left out of the tip-out. The same tips are also rebuilt from the day's checks as a cross-check, and a gap of more than $1 is flagged. If the shifts carry no card tips at all (not every Toast setup records them there), it falls back to `check_time` and says so. `details.tips.cardTipsByMethod` shows each period's card tips under all three check-based methods (`check_time`, `check_items`, `payment`) for comparing with Toast's Tip Summary. Shares are whole cents and always add back to the full amount.
- **Cash tips**: not in Toast. The GM's till counts (4:00 changeover and close) are passed as `cashLunch` / `cashDinner`; until both are given, the result isn't ready.
- **Cash sales**: cash payments excluding tips, for the Cash Out form only.
- **Sales**: non-voided items on non-voided checks, in the period the order was opened. Gross food is items in `foodCategories` before discounts, as Toast reports gross sales; net sales is every category after discounts. Both are pre-tax.
- **Hours**: from clock-in to clock-out, split at the period boundary, minus unpaid breaks. Several time entries for the same person and role are combined.
- **It stops (`ready: false`)** on anything a person needs to resolve: a missing cash count, an open shift, an unmapped job, tips or orders without a time, a period with sales but $0 card tips, or no matching food category. Smaller things, such as hours before 11:00, come back as `check` issues to show the GM.

The skill's scripts need Python 3 and `openpyxl` (`formulas` too, to run the form test that evaluates the spreadsheet's own formulas). They're tested with `python3 -m unittest discover -s skills/stolen-bell-tipout/tests`; `npm test` runs it alongside the server tests, including a test that runs the engine on the server's own output and checks every dollar of the pool is paid out.

## Live mode (your Toast account)

1. In Toast Web, open **Integrations → Toast API access** and create credentials with read access to **Labor**, **Orders**, **Configuration** and **Restaurants**.
2. Copy `.env.example`, fill it in and pass the values to the server through your MCP client's `env` block or your secret manager:

```
TOAST_MCP_MODE=live
TOAST_API_ACCESS_URL=https://ws-api.toasttab.com   # use the API access URL Toast gave you
TOAST_CLIENT_ID=...
TOAST_CLIENT_SECRET=...
TOAST_RESTAURANT_GUID=...
```

The client logs in with Toast's machine-client flow, caches the token, spaces out requests, retries `429` and `5xx` responses (honouring `Retry-After`), and pages through `ordersBulk`. Responses are cached for 5 minutes (reference data for 10), so follow-up questions are quick.

> **Status:** the Toast calls follow Toast's published API and are covered by tests against a fake HTTP layer, but they have not yet been run against a live Toast account. The tip-out relies on payment times (`paidDate`), order open times (`openedDate`) and time-entry `breaks`; if Toast leaves any of those out, the tool stops rather than guessing. Before relying on it, compare the first few nights with Toast's own Labor and Sales Summary reports and with a hand-calculated tip-out.

## Privacy and access

- The server uses one set of Toast credentials, so **anyone who can use the server can see every employee's tips, hours and sales**. Give it to managers, or run it somewhere only the right people can reach.
- Wages are hidden by default. Set `TOAST_INCLUDE_WAGES=true` to add estimated wage cost and labor-cost percentage to `labor_report`.
- No guest names, contact details or card data are requested or returned.
- Credentials are read from environment variables and never appear in tool output.

## Project layout

```
src/
  index.ts            stdio entry point
  server.ts           MCP tool and prompt definitions
  reports.ts          sales / labor / tips report builders
  tipout/inputs.ts    buckets a Toast day into the tip-out skill's Lunch/Dinner input
  tipout/config.ts    tip-out mapping config schema and loader
  data/               Toast data caching, aggregation, date and time-zone helpers
  toast/client.ts     Toast API client (live)
  toast/demo.ts       synthetic demo restaurant
config/tipout.yaml    Toast job / category / period mapping for the tip-out
skills/stolen-bell-tipout/
  SKILL.md            the GM-facing tip-out workflow
  scripts/tipout.py   the tip-out rules (single source of truth)
  scripts/fill_cashout.py  fills the Cash Out form, checking it against the engine
  forms/              Steph's Cash Out form
  tests/              engine tests
test/                 vitest suites
```

The Toast client adapts code from [toast-mcp-2026-complete](https://github.com/BusyBee3333/toast-mcp-2026-complete) (MIT); see [NOTICE.md](NOTICE.md).
