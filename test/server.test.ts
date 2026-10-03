import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ToastRepository } from '../src/data/repository.js';
import { createServer } from '../src/server.js';
import { DemoToastApi } from '../src/toast/demo.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTipoutConfig } from '../src/tipout/config.js';

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError, text, data: result.isError ? undefined : JSON.parse(text) };
}

beforeAll(async () => {
  const config = loadConfig({ TOAST_MCP_MODE: 'demo', TIPOUT_CONFIG_PATH: 'config/tipout.yaml' });
  const server = createServer({
    config,
    repo: new ToastRepository(new DemoToastApi()),
    loadTipoutConfig: () => loadTipoutConfig(config.tipoutConfigPath),
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
      ['get_restaurant_setup', 'get_tipout_inputs', 'labor_report', 'list_staff', 'sales_report', 'tips_report', 'top_items'].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('describes the setup and labels demo data', async () => {
    const { data } = await call('get_restaurant_setup');
    expect(data.dataSource).toMatch(/DEMO/);
    expect(data.jobs.map((j: { title: string }) => j.title)).toContain('Bartender');
    expect(data.tipout.unlistedJobs).toEqual([]);
    expect(data.tipout.otherJobs).toBe('Server');
  });

  it('produces tip-out inputs the skill engine accepts, and the engine reconciles them', async () => {
    const { data } = await call('get_tipout_inputs', { date: '2026-09-26', cashLunch: 42, cashDinner: 118.5 });
    expect(data.ready).toBe(true);
    expect(Object.keys(data.input.periods)).toEqual(['Lunch', 'Dinner']);
    const dinnerRoles = new Set(data.input.periods.Dinner.staff.map((s: { role: string }) => s.role));
    expect(dinnerRoles).toEqual(new Set(['Bartender', 'Server', 'Host', 'Barback', 'Busser', 'Kitchen'])); // Saturday: barback and busser work
    // Devon serves lunch and bartends dinner; Casey's shift crosses 16:00.
    expect(data.input.periods.Lunch.staff).toContainEqual({ name: 'Devon Patel', role: 'Server', hours: 4.75 });
    expect(data.input.periods.Dinner.staff).toContainEqual({ name: 'Devon Patel', role: 'Bartender', hours: 6 });
    expect(data.input.periods.Lunch.staff).toContainEqual({ name: 'Casey Morales', role: 'Bartender', hours: 1 });
    expect(data.input.periods.Dinner.staff).toContainEqual({ name: 'Casey Morales', role: 'Bartender', hours: 8 });

    const file = join(mkdtempSync(join(tmpdir(), 'tipout-')), 'input.json');
    writeFileSync(file, JSON.stringify(data.input));
    const out = JSON.parse(execFileSync('python3', ['skills/stolen-bell-tipout/scripts/tipout.py', file, '--json'], { encoding: 'utf8' }));
    const cents = (v: string) => Math.round(Number(v) * 100);
    const paid = Object.values(out.per_person as Record<string, string>).reduce((sum, v) => sum + cents(v), 0) + cents(out.kitchen_lump_total);
    const pool = (['Lunch', 'Dinner'] as const).reduce((sum, name) => {
      const p = data.input.periods[name];
      return sum + Math.round((p.pool_card_tips + p.auto_gratuity + p.cash_tips_manual) * 100);
    }, 0);
    expect(data.input.periods.Dinner.cash_tips_manual).toBe(118.5);
    expect(out.periods.every((p: { flags: string[] }) => p.flags.length === 0)).toBe(true);
    expect(paid).toBe(pool);
  });

  it('uses the lower support rate on a weekday with no barback', async () => {
    const { data } = await call('get_tipout_inputs', { date: '2026-09-22' });
    const roles = data.input.periods.Dinner.staff.map((s: { role: string }) => s.role);
    expect(roles).not.toContain('Barback');
  });

  it('rejects a malformed date', async () => {
    const result = await call('get_tipout_inputs', { date: '26/09/2026' });
    expect(result.isError).toBe(true);
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
