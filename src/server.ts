import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { businessDates, MAX_RANGE_DAYS } from './data/dates.js';
import type { ToastRepository } from './data/repository.js';
import { laborReport, salesReport, tipsReport, topItemsReport } from './reports.js';
import type { TipoutConfig } from './tipout/config.js';
import { buildTipoutInputs } from './tipout/inputs.js';

export interface ServerDeps {
  config: AppConfig;
  repo: ToastRepository;
  /** Re-read on every call so edits to the tip-out config apply without a restart. */
  loadTipoutConfig: () => Promise<TipoutConfig>;
}

const dateRange = {
  startDate: z.string().describe('First business date, YYYY-MM-DD'),
  endDate: z
    .string()
    .optional()
    .describe(`Last business date, YYYY-MM-DD, inclusive. Defaults to startDate. Ranges are capped at ${MAX_RANGE_DAYS} days.`),
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const guard =
  <A>(handler: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };

export function createServer({ config, repo, loadTipoutConfig }: ServerDeps): McpServer {
  const server = new McpServer({ name: 'toast-staff', version: '0.1.0' });
  const dataNote = config.mode === 'demo' ? 'SYNTHETIC DEMO DATA — not a real restaurant.' : undefined;
  const withNote = (data: object) => (dataNote ? { dataSource: dataNote, ...data } : data);

  server.registerTool(
    'get_restaurant_setup',
    {
      title: 'Restaurant setup',
      description:
        'Restaurant name, time zone, job titles, sales categories, revenue centers, and how jobs map onto tip-out roles. Call this first to learn the exact job and category names other tools use.',
      annotations: readOnly,
    },
    guard(async () => {
      const [ref, tipout] = await Promise.all([repo.reference(), loadTipoutConfig()]);
      return withNote({
        mode: config.mode,
        restaurant: ref.restaurant.general ?? {},
        jobs: [...ref.jobs.values()].map((job) => ({ title: job.title, tipped: job.tipped })),
        salesCategories: [...new Set(ref.salesCategories.values())],
        revenueCenters: [...new Set(ref.revenueCenters.values())],
        tipout: {
          periods: tipout.periods,
          foodCategories: tipout.foodCategories,
          roles: tipout.roles,
          unmappedJobs: [...ref.jobs.values()]
            .map((job) => job.title)
            .filter((title) => !Object.keys(tipout.roles).some((job) => job.toLowerCase() === title.toLowerCase())),
        },
        wagesVisible: config.includeWages,
      });
    }),
  );

  server.registerTool(
    'list_staff',
    {
      title: 'List staff',
      description: 'Active employees and the jobs they can clock in as. No wage or contact information is returned.',
      inputSchema: { includeInactive: z.boolean().default(false).describe('Include deleted/archived employees') },
      annotations: readOnly,
    },
    guard(async ({ includeInactive }: { includeInactive: boolean }) => {
      const ref = await repo.reference();
      return withNote({
        staff: [...ref.employees.values()]
          .filter((employee) => includeInactive || !employee.deleted)
          .map((employee) => ({
            name: employee.name,
            jobs: employee.jobGuids.map((guid) => ref.jobs.get(guid)?.title ?? 'Unknown job'),
            ...(includeInactive ? { inactive: employee.deleted } : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }),
  );

  server.registerTool(
    'sales_report',
    {
      title: 'Sales report',
      description:
        'Net sales, discounts, tax, tips, gratuities, guest and check counts for a date range, optionally broken down by day, server, revenue center or sales category. Voided orders, checks and items are excluded.',
      inputSchema: {
        ...dateRange,
        groupBy: z.enum(['total', 'day', 'server', 'revenue_center', 'sales_category']).default('total'),
      },
      annotations: readOnly,
    },
    guard(async (args: { startDate: string; endDate?: string | undefined; groupBy: 'total' | 'day' | 'server' | 'revenue_center' | 'sales_category' }) =>
      withNote(await salesReport(repo, args, args.groupBy)),
    ),
  );

  server.registerTool(
    'top_items',
    {
      title: 'Top menu items',
      description: 'Best-selling menu items by net sales for a date range.',
      inputSchema: { ...dateRange, limit: z.number().int().min(1).max(100).default(15) },
      annotations: readOnly,
    },
    guard(async (args: { startDate: string; endDate?: string | undefined; limit: number }) =>
      withNote(await topItemsReport(repo, args, args.limit)),
    ),
  );

  server.registerTool(
    'labor_report',
    {
      title: 'Labor report',
      description:
        'Hours worked (regular and overtime) and shift counts from Toast time entries, grouped by employee, job or day. Also lists anyone still clocked in.' +
        (config.includeWages ? ' Includes estimated wage cost and labor cost as a percent of net sales.' : ''),
      inputSchema: { ...dateRange, groupBy: z.enum(['employee', 'job', 'day']).default('employee') },
      annotations: readOnly,
    },
    guard(async (args: { startDate: string; endDate?: string | undefined; groupBy: 'employee' | 'job' | 'day' }) =>
      withNote(await laborReport(repo, args, args.groupBy, config.includeWages)),
    ),
  );

  server.registerTool(
    'tips_report',
    {
      title: 'Tips report',
      description:
        'Tips each employee earned before tip-outs (card tips, declared cash tips and auto-gratuities) per job, with tips per hour.',
      inputSchema: dateRange,
      annotations: readOnly,
    },
    guard(async (args: { startDate: string; endDate?: string | undefined }) => withNote(await tipsReport(repo, args))),
  );

  server.registerTool(
    'get_tipout_inputs',
    {
      title: 'Tip-out inputs',
      description:
        'Pulls everything the Stolen Bell tip-out needs for one business day, split into Lunch and Dinner: card tips and auto-gratuity by when they were paid, ' +
        'food and net sales by when the order was opened, cash sales for the Cash Out form, and each person\'s hours by tip-out role, split at the period boundary with unpaid breaks removed. ' +
        'Cash tips are not in Toast: pass the GM\'s till counts (4:00 changeover for Lunch, close for Dinner) as cashLunch and cashDinner. ' +
        '`input` is the exact document the tip-out engine (skills/stolen-bell-tipout/scripts/tipout.py) reads. ' +
        'If `ready` is false, an issue with severity "stop" must be resolved by a person before running the engine; never estimate around it. ' +
        'This tool does not calculate payouts.',
      inputSchema: {
        date: z.string().describe('Business date, YYYY-MM-DD'),
        cashLunch: z.number().min(0).optional().describe('Cash tips counted from the till at the 4:00 changeover (0 if none). Required before the result is ready.'),
        cashDinner: z.number().min(0).optional().describe('Cash tips counted from the till at close (0 if none). Required before the result is ready.'),
      },
      annotations: readOnly,
    },
    guard(async ({ date, cashLunch, cashDinner }: { date: string; cashLunch?: number | undefined; cashDinner?: number | undefined }) => {
      const [businessDate] = businessDates(date);
      const [ref, day, tipout] = await Promise.all([repo.reference(), repo.day(businessDate!), loadTipoutConfig()]);
      return withNote(buildTipoutInputs(day, ref, tipout, { Lunch: cashLunch, Dinner: cashDinner }));
    }),
  );

  return server;
}
