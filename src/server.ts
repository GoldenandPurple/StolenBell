import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { MAX_RANGE_DAYS } from './data/dates.js';
import type { ToastRepository } from './data/repository.js';
import { describeRule, laborReport, salesReport, tipOutReport, tipsReport, topItemsReport } from './reports.js';
import { TipRuleSchema, TipSourcesSchema, type TipRulesFile } from './tipout/rules.js';

export interface ServerDeps {
  config: AppConfig;
  repo: ToastRepository;
  /** Re-read on every call so edits to the rules file apply without a restart. */
  loadRules: () => Promise<TipRulesFile>;
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

export function createServer({ config, repo, loadRules }: ServerDeps): McpServer {
  const server = new McpServer({ name: 'toast-staff', version: '0.1.0' });
  const dataNote = config.mode === 'demo' ? 'SYNTHETIC DEMO DATA — not a real restaurant.' : undefined;
  const withNote = (data: object) => (dataNote ? { dataSource: dataNote, ...data } : data);

  server.registerTool(
    'get_restaurant_setup',
    {
      title: 'Restaurant setup',
      description:
        'Restaurant name, time zone, job titles, sales categories, revenue centers and the configured tip-out rules. Call this first to learn the exact job and category names other tools use.',
      annotations: readOnly,
    },
    guard(async () => {
      const [ref, rules] = await Promise.all([repo.reference(), loadRules()]);
      return withNote({
        mode: config.mode,
        restaurant: ref.restaurant.general ?? {},
        jobs: [...ref.jobs.values()].map((job) => ({ title: job.title, tipped: job.tipped })),
        salesCategories: [...new Set(ref.salesCategories.values())],
        revenueCenters: [...new Set(ref.revenueCenters.values())],
        tipSources: rules.tipSources,
        tipOutRules: rules.rules.map(describeRule),
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
    'calculate_tip_out',
    {
      title: 'Calculate tip-out',
      description:
        "Calculates tip-outs and tip pools using the restaurant's configured rules (or rules passed in to try a what-if scenario). " +
        'Each business day is settled separately, then totalled per employee. Shows what each person earned, paid out, received and takes home. ' +
        'This only calculates; it never changes anything in Toast or payroll.',
      inputSchema: {
        ...dateRange,
        rules: z
          .array(TipRuleSchema)
          .optional()
          .describe('Override the configured rules for a what-if scenario. Job titles must match get_restaurant_setup.'),
        tipSources: TipSourcesSchema.optional().describe('Override which tip types count as earned tips'),
      },
      annotations: { ...readOnly, idempotentHint: true },
    },
    guard(async (args: { startDate: string; endDate?: string | undefined; rules?: z.infer<typeof TipRuleSchema>[] | undefined; tipSources?: z.infer<typeof TipSourcesSchema> | undefined }) => {
      const configured = await loadRules();
      const rules = args.rules ?? configured.rules;
      if (rules.length === 0) {
        throw new Error(
          `No tip-out rules are configured (looked in ${config.tipRulesPath}). Add rules there, or pass rules to this tool.`,
        );
      }
      const report = await tipOutReport(repo, args, rules, args.tipSources ?? configured.tipSources);
      return withNote({ ...(args.rules ? { scenario: 'What-if: using rules passed in, not the configured rules' } : {}), ...report });
    }),
  );

  server.registerPrompt(
    'nightly_tip_out',
    {
      title: 'Nightly tip-out sheet',
      description: "Produce tonight's tip-out sheet for the closing manager.",
      argsSchema: { date: z.string().describe('Business date, YYYY-MM-DD') },
    },
    ({ date }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Run calculate_tip_out for ${date}. Present a table with each employee, their job, hours, tips earned, ` +
              'tip-out paid, tip-out received and final tips, sorted by job. Then list the pot for each rule. ' +
              'Call out anyone still clocked in and any warnings before the table, because those make the numbers provisional.',
          },
        },
      ],
    }),
  );

  return server;
}
