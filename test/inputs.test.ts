import { describe, expect, it } from 'vitest';
import type { DayData, Reference } from '../src/data/repository.js';
import { zonedTimeToUtc } from '../src/data/zoned.js';
import { TipoutConfigSchema } from '../src/tipout/config.js';
import { buildTipoutInputs } from '../src/tipout/inputs.js';
import type { ToastOrder, ToastTimeEntry } from '../src/toast/types.js';

const TZ = 'America/Vancouver';
const DATE = '2026-09-27';
const at = (hhmm: string, nextDay = false) =>
  new Date(zonedTimeToUtc(DATE, hhmm, TZ) + (nextDay ? 86_400_000 : 0)).toISOString().replace('Z', '+0000');

const ref: Reference = {
  restaurant: { general: { name: 'Test', timeZone: TZ } },
  jobs: new Map([
    ['j-bar', { title: 'Bartender', tipped: true }],
    ['j-srv', { title: 'Server', tipped: true }],
    ['j-host', { title: 'Host', tipped: true }],
    ['j-chef', { title: 'Chef', tipped: false }],
    ['j-som', { title: 'Sommelier', tipped: true }],
  ]),
  employees: new Map([
    ['e-mara', { name: 'Mara', jobGuids: [], deleted: false }],
    ['e-devon', { name: 'Devon', jobGuids: [], deleted: false }],
    ['e-priya', { name: 'Priya', jobGuids: [], deleted: false }],
    ['e-luis', { name: 'Luis', jobGuids: [], deleted: false }],
    ['e-sam1', { name: 'Sam', jobGuids: [], deleted: false }],
    ['e-sam2', { name: 'Sam', jobGuids: [], deleted: false }],
  ]),
  salesCategories: new Map([
    ['c-food', 'Food'],
    ['c-liq', 'Liquor'],
  ]),
  revenueCenters: new Map(),
};

const config = TipoutConfigSchema.parse({
  roles: { Bartender: 'Bartender', Server: 'Server', Host: 'Host', Chef: 'Kitchen' },
});

const entry = (employee: string, job: string, inDate: string, outDate: string | null, extra: Partial<ToastTimeEntry> = {}): ToastTimeEntry => ({
  guid: `${employee}-${job}-${inDate}`,
  employeeReference: { guid: employee },
  jobReference: { guid: job },
  inDate,
  outDate,
  ...extra,
});

const order = (opened: string, paid: string, food: number, liquor: number, tip: number, type = 'CREDIT'): ToastOrder => ({
  guid: `o-${opened}-${food}-${liquor}`,
  openedDate: opened,
  checks: [
    {
      selections: [
        { price: food, salesCategory: { guid: 'c-food' } },
        { price: liquor, salesCategory: { guid: 'c-liq' } },
        { price: 999, voided: true, salesCategory: { guid: 'c-food' } },
      ],
      payments: [{ type, tipAmount: tip, paidDate: paid, paymentStatus: 'CAPTURED' }],
    },
  ],
});

const baseDay = (): DayData => ({
  businessDate: '20260927',
  timeEntries: [
    entry('e-mara', 'j-bar', at('10:30'), at('18:00')), // 30 min before lunch, 5h lunch, 2h dinner
    entry('e-devon', 'j-srv', at('16:00'), at('00:30', true), {
      breaks: [{ paid: false, inDate: at('19:00'), outDate: at('19:30') }, { paid: true, inDate: at('21:00'), outDate: at('21:15') }],
    }),
    entry('e-devon', 'j-srv', at('11:00'), at('15:00')),
    entry('e-priya', 'j-host', at('17:00'), at('21:00')),
    entry('e-luis', 'j-chef', at('09:00'), at('22:00')),
  ],
  orders: [
    order(at('12:00'), at('12:45'), 100, 20, 25),
    order(at('15:30'), at('16:10'), 50, 0, 10), // opened at lunch, paid at dinner
    order(at('19:00'), at('20:00'), 200, 80, 60),
    order(at('20:00'), at('21:00'), 40, 10, 9, 'CASH'),
    { ...order(at('21:00'), at('21:30'), 500, 0, 100), voided: true },
  ],
});

describe('buildTipoutInputs', () => {
  it('splits sales by order time and card tips by payment time', () => {
    const result = buildTipoutInputs(baseDay(), ref, config);
    expect(result.input.periods.Lunch).toMatchObject({ pool_card_tips: 25, gross_food_sales: 150, net_sales: 170 });
    expect(result.input.periods.Dinner).toMatchObject({ pool_card_tips: 70, gross_food_sales: 240, net_sales: 330, cash_tips_manual: null });
    expect(result.details.perPeriod.Dinner.cashTipsRecordedInToast).toBe(9);
  });

  it('splits hours at 16:00, ignores time before 11:00, removes unpaid breaks only, and merges same-role entries', () => {
    const { Lunch, Dinner } = buildTipoutInputs(baseDay(), ref, config).input.periods;
    expect(Lunch!.staff).toEqual([
      { name: 'Mara', role: 'Bartender', hours: 5 },
      { name: 'Luis', role: 'Kitchen', hours: 5 },
      { name: 'Devon', role: 'Server', hours: 4 },
    ]);
    expect(Dinner!.staff).toEqual([
      { name: 'Mara', role: 'Bartender', hours: 2 },
      { name: 'Priya', role: 'Host', hours: 4 },
      { name: 'Luis', role: 'Kitchen', hours: 6 },
      { name: 'Devon', role: 'Server', hours: 8 }, // 8.5h minus a 30-min unpaid break; paid break kept
    ]);
  });

  it('is ready on a clean day and passes GM cash through', () => {
    const result = buildTipoutInputs(baseDay(), ref, config, { Dinner: 120 });
    expect(result.ready).toBe(true);
    expect(result.input.periods.Dinner!.cash_tips_manual).toBe(120);
    expect(result.issues.filter((i) => i.severity === 'stop')).toEqual([]);
    expect(result.issues.map((i) => i.message).join()).toMatch(/Mara \(Bartender\) worked 0.50 h before 11:00/);
  });

  it('stops on an open shift', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-priya', 'j-host', at('11:00'), null));
    const result = buildTipoutInputs(day, ref, config);
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/Priya \(Host\) is still clocked in/) });
  });

  it('stops on a job with no role mapping, and lets "ignore" through', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-som', at('17:00'), at('22:00')));
    expect(buildTipoutInputs(day, ref, config).issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/"Sommelier" isn't mapped/) });
    const ignoring = TipoutConfigSchema.parse({ ...config, roles: { ...config.roles, Sommelier: 'ignore' } });
    expect(buildTipoutInputs(day, ref, ignoring).ready).toBe(true);
  });

  it('stops when a period has sales but no card tips', () => {
    const day = baseDay();
    day.orders = day.orders.filter((o) => !o.openedDate!.startsWith(at('12:00').slice(0, 16)));
    day.orders.push(order(at('13:00'), at('13:30'), 80, 0, 0));
    const result = buildTipoutInputs(day, ref, config);
    expect(result.issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/^Lunch has .* \$0 in card tips/) });
  });

  it('stops when no configured food category exists in Toast', () => {
    const wrong = TipoutConfigSchema.parse({ ...config, foodCategories: ['Kitchen Food'] });
    expect(buildTipoutInputs(baseDay(), ref, wrong).ready).toBe(false);
  });

  it('gives two different people with the same name distinct names', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-srv', at('17:00'), at('22:00')), entry('e-sam2', 'j-srv', at('17:00'), at('21:00')));
    const names = buildTipoutInputs(day, ref, config).input.periods.Dinner!.staff.map((s) => s.name);
    expect(names).toContain('Sam (e-sam1)');
    expect(names).toContain('Sam (e-sam2)');
  });
});

describe('zonedTimeToUtc', () => {
  it('handles daylight saving on both sides of the change', () => {
    expect(new Date(zonedTimeToUtc('2026-07-01', '16:00', TZ)).toISOString()).toBe('2026-07-01T23:00:00.000Z');
    expect(new Date(zonedTimeToUtc('2026-12-01', '16:00', TZ)).toISOString()).toBe('2026-12-02T00:00:00.000Z');
  });
});
