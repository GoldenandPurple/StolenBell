# Toast staff MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that sits on top of the Toast POS API, so staff and managers can ask an AI assistant (Claude Desktop, Claude Code, or any MCP client) things like:

- "Run tonight's tip-out."
- "What would the tip-out have been last week if the kitchen got 3% of sales instead of 5% of tips?"
- "Sales by server for Friday and Saturday."
- "Who's still clocked in?" / "Hours by job this pay period."

It only reads from Toast. It never changes anything in Toast or payroll.

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
      "env": { "TOAST_MCP_MODE": "demo", "TIP_RULES_PATH": "/absolute/path/to/StolenBell/config/tip-rules.yaml" }
    }
  }
}
```

Demo mode serves a made-up restaurant with servers, bartenders, bussers, a host and a kitchen. Every response is labelled as demo data.

## Tools

| Tool | What it does |
| --- | --- |
| `get_restaurant_setup` | Restaurant info, job titles, sales categories, revenue centers and the tip-out rules in effect. |
| `list_staff` | Employees and the jobs they can clock in as. Returns no wages or contact details. |
| `sales_report` | Net sales, discounts, tax, tips, gratuities, guests and checks, by `total`, `day`, `server`, `revenue_center` or `sales_category`. |
| `top_items` | Best-selling menu items by net sales. |
| `labor_report` | Regular and overtime hours and shift counts by employee, job or day, plus who is still clocked in. |
| `tips_report` | Tips per employee and job before tip-outs: card tips, declared cash tips and auto-gratuities, plus tips per hour. |
| `calculate_tip_out` | Applies the tip-out rules per business day and totals each person's earned, paid out, received and final tips. Accepts `rules` for what-if scenarios. |

There is also a `nightly_tip_out` prompt that produces a closing manager's tip-out sheet.

Dates are Toast business dates (`YYYY-MM-DD`). A range can be up to 31 days.

## Tip-out rules

Rules live in [`config/tip-rules.yaml`](config/tip-rules.yaml). The file is re-read on every calculation, so edits apply straight away. Each rule says who pays (`from`), who shares (`to`), how much and on what basis:

```yaml
rules:
  - name: Bar tip-out            # servers give bartenders 5% of alcohol sales
    from: [Server]
    to: [Bartender]
    basis: sales
    salesCategories: [Liquor, Beer, Wine]
    percent: 5
    capAtTips: true

  - name: Kitchen                # 5% of tips to the kitchen, split by hours
    from: [Server, Bartender]
    to: [Line Cook, Dishwasher]
    basis: tips
    percent: 5

  - name: FOH pool               # a pool: from and to overlap
    from: [Server, Bartender]
    to: [Server, Bartender, Busser]
    basis: remaining_tips
    percent: 100
    points: { Busser: 0.5 }
```

| Field | Meaning |
| --- | --- |
| `basis` | `sales` = the contributor's net sales (optionally only `salesCategories`); `tips` = tips they earned; `remaining_tips` = what they still hold after earlier rules. |
| `split` | `hours` (default) shares by hours worked in a `to` job; `equal` gives one share per person. |
| `points` | Weights per recipient job, e.g. a host at half a share. |
| `capAtTips` | Never take more than the contributor currently holds. Without it, a sales-based rule can leave someone negative; that is reported as a warning. |
| `tipSources` | Top-level setting for which tip types count as earned tips: `cardTips`, `declaredCashTips`, `gratuities`. |

How the calculation works:

- Rules run in file order, once per business day; a multi-day range is settled day by day and then totalled.
- Money is handled in whole cents. Pots are divided by the largest-remainder method, so payouts always add up to the pot exactly.
- If nobody worked a `to` job that day, that rule collects nothing and the report says so.
- Job titles and categories are matched case-insensitively against the names in Toast. Run `get_restaurant_setup` to see them.

### Where the numbers come from

- **Hours and tips** come from Toast **time entries** (Labor API), so they belong to the job the person clocked in as. Card tips are `nonCashTips`, cash tips are `declaredCashTips`, and gratuities are the gratuity service-charge fields.
- **Sales** come from **orders**: the net price of non-voided items on non-voided checks, credited to the order's server. A sale only counts toward someone's tip-out if they clocked in that day. If someone worked two jobs in one day, all of their sales count toward any rule they pay into.
- If anyone is still clocked in, the report lists them. Their hours and tips are incomplete until they clock out.

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

> **Status:** the Toast calls follow Toast's published API and are covered by tests against a fake HTTP layer, but they have not yet been run against a live Toast account. Before relying on it, compare the first few nights of results with Toast's own Labor and Sales Summary reports.

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
  reports.ts          sales / labor / tips / tip-out report builders
  tipout/engine.ts    tip-out calculation (pure, cents-based)
  tipout/rules.ts     rules file schema and loader
  data/               Toast data caching, aggregation, date helpers
  toast/client.ts     Toast API client (live)
  toast/demo.ts       synthetic demo restaurant
config/tip-rules.yaml house tip-out rules
test/                 vitest suites
```

The Toast client adapts code from [toast-mcp-2026-complete](https://github.com/BusyBee3333/toast-mcp-2026-complete) (MIT); see [NOTICE.md](NOTICE.md).
