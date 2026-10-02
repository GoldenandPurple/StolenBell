import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ToastRepository } from '../src/data/repository.js';
import { createServer } from '../src/server.js';
import { DemoToastApi } from '../src/toast/demo.js';
import { loadTipRules } from '../src/tipout/rules.js';

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError, text, data: result.isError ? undefined : JSON.parse(text) };
}

beforeAll(async () => {
  const config = loadConfig({ TOAST_MCP_MODE: 'demo', TIP_RULES_PATH: 'config/tip-rules.yaml' });
  const server = createServer({
    config,
    repo: new ToastRepository(new DemoToastApi()),
    loadRules: () => loadTipRules(config.tipRulesPath),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

describe('MCP server (demo mode)', () => {
  it('lists the tools, all read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['calculate_tip_out', 'get_restaurant_setup', 'labor_report', 'list_staff', 'sales_report', 'tips_report', 'top_items'].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('describes the setup and labels demo data', async () => {
    const { data } = await call('get_restaurant_setup');
    expect(data.dataSource).toMatch(/DEMO/);
    expect(data.jobs.map((j: { title: string }) => j.title)).toContain('Bartender');
    expect(data.tipOutRules).toHaveLength(3);
  });

  it('calculates a tip-out where money is only moved, never created', async () => {
    const { data } = await call('calculate_tip_out', { startDate: '2026-09-26' });
    const sum = (key: string) => data.employees.reduce((total: number, e: Record<string, number>) => total + Math.round(e[key]! * 100), 0);
    expect(sum('tipOutPaid')).toBe(sum('tipOutReceived'));
    expect(sum('finalTips')).toBe(sum('tipsEarned'));
    const cooks = data.employees.filter((e: { jobs: string[] }) => e.jobs.includes('Line Cook'));
    expect(cooks.length).toBeGreaterThan(0);
    expect(cooks.every((e: { tipOutReceived: number }) => e.tipOutReceived > 0)).toBe(true);
  });

  it('runs a what-if with rules passed in', async () => {
    const { data } = await call('calculate_tip_out', {
      startDate: '2026-09-26',
      rules: [{ name: 'Everyone pools', from: ['Server', 'Bartender'], to: ['Server', 'Bartender', 'Busser'], basis: 'tips', percent: 100 }],
    });
    expect(data.scenario).toMatch(/What-if/);
    expect(Object.keys(data.ruleTotals)).toEqual(['Everyone pools']);
  });

  it('settles multi-day ranges per day', async () => {
    const { data } = await call('calculate_tip_out', { startDate: '2026-09-21', endDate: '2026-09-27' });
    expect(data.days).toHaveLength(7);
  });

  it('reports sales that reconcile across groupings', async () => {
    const total = (await call('sales_report', { startDate: '2026-09-25', endDate: '2026-09-27' })).data.totals.netSales;
    const byServer = (await call('sales_report', { startDate: '2026-09-25', endDate: '2026-09-27', groupBy: 'server' })).data.groups;
    const byCategory = (await call('sales_report', { startDate: '2026-09-25', endDate: '2026-09-27', groupBy: 'sales_category' })).data.groups;
    const add = (rows: { netSales: number }[]) => Math.round(rows.reduce((s, r) => s + r.netSales * 100, 0));
    expect(add(byServer)).toBe(Math.round(total * 100));
    expect(add(byCategory)).toBe(Math.round(total * 100));
  });

  it('keeps wages out of the labor report unless enabled', async () => {
    const { data } = await call('labor_report', { startDate: '2026-09-26', groupBy: 'job' });
    expect(data.totals.estimatedWageCost).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/wage/i);
  });

  it('returns tips per employee and top items', async () => {
    const tips = (await call('tips_report', { startDate: '2026-09-26' })).data;
    expect(tips.employees[0].totalTips).toBeGreaterThan(0);
    const items = (await call('top_items', { startDate: '2026-09-26', limit: 3 })).data;
    expect(items.items).toHaveLength(3);
  });

  it('returns a readable error for bad dates', async () => {
    const result = await call('sales_report', { startDate: '2026-01-01', endDate: '2026-06-01' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/limited to 31 days/);
  });
});
