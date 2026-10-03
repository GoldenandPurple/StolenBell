import { describe, expect, it } from 'vitest';
import type { DayData, Reference } from '../src/data/repository.js';
import { zonedTimeToUtc } from '../src/data/zoned.js';
import { TipoutConfigSchema } from '../src/tipout/config.js';
import { buildTipoutInputs, normalize, shortName } from '../src/tipout/inputs.js';
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
  restaurantServices: new Map([
    ['svc-l', 'Lunch'],
    ['svc-d', 'Dinner Service'],
  ]),
};

const CASH = { Lunch: 0, Dinner: 0 };

// Most tests below rebuild tips from the checks; the shift-based default has its own block.
const config = TipoutConfigSchema.parse({
  roles: { Bartender: 'Bartender', Server: 'Server', Host: 'Host', Chef: 'Kitchen' },
  cardTipSource: 'check_time',
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
  it('shares a check\'s card tip between periods by how long it was open in each (default)', () => {
    const result = buildTipoutInputs(baseDay(), ref, config, CASH);
    // The 15:30-16:10 check's $10 tip: 30 min lunch, 10 min dinner -> $7.50 / $2.50.
    expect(result.input.periods.Lunch).toMatchObject({ pool_card_tips: 32.5, gross_food_sales: 150, net_sales: 170 });
    expect(result.input.periods.Dinner).toMatchObject({ pool_card_tips: 62.5, gross_food_sales: 240, net_sales: 330, cash_tips_manual: 0 });
    expect(result.details.tips.spanningBothPeriods).toEqual({ count: 1, toLunch: 7.5, toDinner: 2.5 });
    expect(result.details.perPeriod.Dinner.cashTipsRecordedInToast).toBe(9);
  });

  it('can put card tips in the period they were paid instead', () => {
    const byPayment = TipoutConfigSchema.parse({ ...config, cardTipSource: 'payment' });
    const result = buildTipoutInputs(baseDay(), ref, byPayment, CASH);
    expect(result.input.periods.Lunch!.pool_card_tips).toBe(25);
    expect(result.input.periods.Dinner!.pool_card_tips).toBe(70);
    expect(result.details.tips.spanningBothPeriods.count).toBe(0);
  });

  it('can share card tips by the sales rung in each period', () => {
    const byItems = TipoutConfigSchema.parse({ ...config, cardTipSource: 'check_items' });
    const day = baseDay();
    const spanning = order(at('15:00'), at('17:00'), 0, 0, 20);
    spanning.checks![0]!.selections = [
      { price: 30, createdDate: at('15:05'), salesCategory: { guid: 'c-food' } },
      { price: 90, createdDate: at('16:30'), salesCategory: { guid: 'c-food' } },
      { price: 500, voided: true, createdDate: at('15:10'), salesCategory: { guid: 'c-food' } },
    ];
    day.orders = [spanning];
    const { Lunch, Dinner } = buildTipoutInputs(day, ref, byItems, CASH).input.periods;
    expect([Lunch!.pool_card_tips, Dinner!.pool_card_tips]).toEqual([5, 15]); // $30 vs $90 rung
    expect(Lunch!.net_sales).toBe(120); // sales still follow when the order was opened
  });

  it("can follow Toast's own Lunch/Dinner service on each order", () => {
    const byService = TipoutConfigSchema.parse({ ...config, cardTipSource: 'restaurant_service' });
    const day = baseDay();
    day.orders[1]!.restaurantService = { guid: 'svc-d' }; // the 15:30-16:10 check, which Toast put in Dinner
    const result = buildTipoutInputs(day, ref, byService, CASH);
    // The $10 tip on the check open 15:30-16:10 goes wholly to Dinner because Toast tagged the order Dinner;
    // untagged orders fall back to time open.
    expect(result.input.periods.Lunch!.pool_card_tips).toBe(25);
    expect(result.input.periods.Dinner!.pool_card_tips).toBe(70);
    expect(result.details.tips.cardTipsByMethod.restaurant_service).toEqual({ Lunch: 25, Dinner: 70 });
    expect(result.details.tips.cardTipsWithoutToastService).toBe(85);
  });

  it('keeps every cent when a tip is shared', () => {
    const day = baseDay();
    day.orders = [order(at('15:00'), at('16:30'), 10, 0, 10.01)]; // 60 min lunch, 30 min dinner
    const { Lunch, Dinner } = buildTipoutInputs(day, ref, config, CASH).input.periods;
    expect([Lunch!.pool_card_tips, Dinner!.pool_card_tips]).toEqual([6.67, 3.34]);
  });

  it('counts gross food before discounts and net sales after', () => {
    const day = baseDay();
    const discounted = order(at('13:00'), at('13:30'), 0, 0, 5);
    discounted.checks![0]!.selections = [{ price: 40, preDiscountPrice: 50, salesCategory: { guid: 'c-food' } }];
    day.orders.push(discounted);
    const lunch = buildTipoutInputs(day, ref, config, CASH).input.periods.Lunch!;
    expect(lunch.gross_food_sales).toBe(150 + 50);
    expect(lunch.net_sales).toBe(170 + 40);
  });

  it('shares auto-gratuity like card tips, and totals cash sales', () => {
    const day = baseDay();
    const party = order(at('15:20'), at('16:05'), 300, 0, 0);
    party.checks![0]!.appliedServiceCharges = [{ name: 'Auto grat', chargeAmount: 54, gratuity: true }, { name: 'Corkage', chargeAmount: 20, gratuity: false }];
    day.orders.push(party);
    const { Lunch, Dinner } = buildTipoutInputs(day, ref, config, CASH).input.periods;
    // 15:20-16:05: 40 min lunch, 5 min dinner
    expect(Lunch!.auto_gratuity).toBe(48);
    expect(Dinner!.auto_gratuity).toBe(6);
    expect(Lunch!.net_sales).toBe(470); // the party's sales stay with the period it was opened in
    day.orders[3]!.checks![0]!.payments![0]!.amount = 52.5;
    expect(buildTipoutInputs(day, ref, config, CASH).input.periods.Dinner!.cash_sales).toBe(52.5);
  });

  it('splits hours at 16:00, ignores time before 11:00, removes unpaid breaks only, and merges same-role entries', () => {
    const { Lunch, Dinner } = buildTipoutInputs(baseDay(), ref, config, CASH).input.periods;
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

  it('needs both till counts before it is ready', () => {
    const missing = buildTipoutInputs(baseDay(), ref, config, { Dinner: 120 });
    expect(missing.ready).toBe(false);
    expect(missing.issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/^Enter the Lunch cash tip count \(till count at the 4:00 changeover\)/) });
    expect(missing.issues.map((i) => i.message).join()).not.toMatch(/Enter the Dinner/);
  });

  it('is ready on a clean day and passes the till counts through', () => {
    const result = buildTipoutInputs(baseDay(), ref, config, { Lunch: 35.5, Dinner: 120 });
    expect(result.ready).toBe(true);
    expect(result.input.periods.Lunch!.cash_tips_manual).toBe(35.5);
    expect(result.input.periods.Dinner!.cash_tips_manual).toBe(120);
    expect(result.issues.filter((i) => i.severity === 'stop')).toEqual([]);
    expect(result.issues.map((i) => i.message).join()).toMatch(/Mara \(Bartender\) worked 0.50 h before 11:00/);
  });

  it('stops on an open shift', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-priya', 'j-host', at('11:00'), null));
    const result = buildTipoutInputs(day, ref, config, CASH);
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/Priya \(Host\) is still clocked in/) });
  });

  it('stops on a job with no role mapping, and lets "ignore" through', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-som', at('17:00'), at('22:00')));
    expect(buildTipoutInputs(day, ref, config, CASH).issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/"Sommelier" isn't mapped/) });
    const ignoring = TipoutConfigSchema.parse({ ...config, roles: { ...config.roles, Sommelier: 'ignore' } });
    expect(buildTipoutInputs(day, ref, ignoring, CASH).ready).toBe(true);
  });

  it('stops when a period has sales but no card tips', () => {
    const day = baseDay();
    day.orders = day.orders.filter((o) => Date.parse(o.openedDate!) >= Date.parse(at('16:00')));
    day.orders.push(order(at('13:00'), at('13:30'), 80, 0, 0));
    const result = buildTipoutInputs(day, ref, config, CASH);
    expect(result.issues).toContainEqual({ severity: 'stop', message: expect.stringMatching(/^Lunch has .* \$0 in card tips/) });
  });

  it('stops when no configured food category exists in Toast', () => {
    const wrong = TipoutConfigSchema.parse({ ...config, foodCategories: ['Kitchen Food'] });
    expect(buildTipoutInputs(baseDay(), ref, wrong, CASH).ready).toBe(false);
  });

  it('gives two different people with the same name distinct names', () => {
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-srv', at('17:00'), at('22:00')), entry('e-sam2', 'j-srv', at('17:00'), at('21:00')));
    const names = buildTipoutInputs(day, ref, config, CASH).input.periods.Dinner!.staff.map((s) => s.name);
    expect(names).toContain('Sam (e-sam1)');
    expect(names).toContain('Sam (e-sam2)');
  });
});

describe('buildTipoutInputs with tips from Toast shifts (default)', () => {
  const shiftConfig = TipoutConfigSchema.parse({ ...config, cardTipSource: 'time_entries' });
  const tipped = (): DayData => {
    const day = baseDay();
    day.timeEntries = [
      entry('e-mara', 'j-bar', at('10:30'), at('18:00'), { nonCashTips: 100, nonCashGratuityServiceCharges: 12 }), // 5h lunch, 2h dinner
      entry('e-devon', 'j-srv', at('11:00'), at('15:00'), { nonCashTips: 40 }),
      entry('e-devon', 'j-srv', at('16:00'), at('00:30', true), {
        nonCashTips: 60.5,
        breaks: [{ paid: false, inDate: at('19:00'), outDate: at('19:30') }],
      }),
      entry('e-priya', 'j-host', at('17:00'), at('21:00')),
      entry('e-luis', 'j-chef', at('09:00'), at('22:00')),
    ];
    return day;
  };

  it("uses the tips Toast credited to each shift, splitting a shift that crosses 4:00 by time worked", () => {
    const result = buildTipoutInputs(tipped(), ref, shiftConfig, CASH);
    // Mara's shift counts from 10:30, so it's 5.5h before 16:00 and 2h after: $100 -> 73.33 / 26.67.
    expect(result.input.periods.Lunch).toMatchObject({ pool_card_tips: 40 + 73.33, auto_gratuity: 8.8 });
    expect(result.input.periods.Dinner).toMatchObject({ pool_card_tips: 60.5 + 26.67, auto_gratuity: 3.2 });
    expect(result.details.tips.source).toBe('time_entries');
    expect(result.details.tips.spanningBothPeriods.count).toBe(1);
  });

  it('flags when shift tips and check tips disagree, but still uses the shift figures', () => {
    const result = buildTipoutInputs(tipped(), ref, shiftConfig, CASH);
    expect(result.ready).toBe(true);
    // The test checks carry $95 of card tips; the shifts carry $200.50.
    expect(result.details.tips.cardTipsOnChecks).toEqual({ Lunch: 32.5, Dinner: 62.5 });
    expect(result.issues).toContainEqual({ severity: 'check', message: expect.stringMatching(/shifts total \$200\.50, but card tips on the day's checks total \$95\.00/) });
  });

  it('falls back to the checks when Toast has no card tips on the shifts, instead of a $0 pool', () => {
    const result = buildTipoutInputs(baseDay(), ref, shiftConfig, CASH); // base shifts carry no tips
    expect(result.details.tips.source).toBe('check_time');
    expect(result.input.periods.Lunch!.pool_card_tips).toBe(32.5);
    expect(result.input.periods.Dinner!.pool_card_tips).toBe(62.5);
    expect(result.issues).toContainEqual({ severity: 'check', message: expect.stringMatching(/no card tips on the shift records/) });
    // All three check methods side by side, for comparing with Toast's Tip Summary.
    expect(result.details.tips.cardTipsByMethod).toEqual({
      restaurant_service: { Lunch: 32.5, Dinner: 62.5 }, // test orders have no Toast service, so time open is used
      check_time: { Lunch: 32.5, Dinner: 62.5 },
      check_items: { Lunch: 35, Dinner: 60 }, // the test items have no times, so they count from when the check opened
      payment: { Lunch: 25, Dinner: 70 },
    });
  });

  it("counts tips from shifts in jobs that aren't in the tip-out (e.g. a manager who took a table)", () => {
    const day = tipped();
    day.timeEntries.push(entry('e-sam1', 'j-som', at('18:00'), at('20:00'), { nonCashTips: 30 }));
    const withIgnored = TipoutConfigSchema.parse({ ...shiftConfig, roles: { ...shiftConfig.roles, Sommelier: 'ignore' } });
    const result = buildTipoutInputs(day, ref, withIgnored, CASH);
    expect(result.input.periods.Dinner!.pool_card_tips).toBe(60.5 + 26.67 + 30);
    expect(result.input.periods.Dinner!.staff.map((s) => s.name)).not.toContain('Sam');
  });
});

describe('jobs not listed in the config', () => {
  it('can give unlisted jobs a role and say so', () => {
    const catchAll = TipoutConfigSchema.parse({ ...config, otherJobs: 'Server' });
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-som', at('17:00'), at('22:00')));
    const result = buildTipoutInputs(day, ref, catchAll, CASH);
    expect(result.ready).toBe(true);
    expect(result.input.periods.Dinner!.staff).toContainEqual({ name: 'Sam', role: 'Server', hours: 5 });
    expect(result.details.jobMapping.Sommelier).toBe('Server (not listed; otherJobs)');
    expect(result.issues).toContainEqual({ severity: 'check', message: expect.stringMatching(/treated as Server: Sommelier/) });
  });

  it('lets an explicit "ignore" win over the catch-all', () => {
    const catchAll = TipoutConfigSchema.parse({ ...config, otherJobs: 'Server', roles: { ...config.roles, Sommelier: 'ignore' } });
    const day = baseDay();
    day.timeEntries.push(entry('e-sam1', 'j-som', at('17:00'), at('22:00')));
    const result = buildTipoutInputs(day, ref, catchAll, CASH);
    expect(result.input.periods.Dinner!.staff.map((s) => s.name)).not.toContain('Sam');
    expect(result.issues.map((i) => i.message).join()).not.toMatch(/treated as/);
  });
});

describe('job title matching', () => {
  it('ignores case, spacing and punctuation but not words', () => {
    expect(normalize('Lead Bartender - ADMIN')).toBe(normalize('Lead Bartender ADMIN'));
    expect(normalize('General  Manager ')).toBe(normalize('General Manager'));
    expect(normalize('General\u00a0Manager')).toBe(normalize('General Manager'));
    expect(normalize('Chef OFFICE')).not.toBe(normalize('Chef'));
    expect(normalize('Lead Bartender ADMIN')).not.toBe(normalize('Lead Bartender'));
  });
});

describe('names on the sheet', () => {
  it('uses first name and last initial', () => {
    expect(shortName('Mara Chen')).toBe('Mara C.');
    expect(shortName('Ana María de la Cruz')).toBe('Ana C.');
    expect(shortName('Priya')).toBe('Priya');
    expect(shortName('Unknown employee (abc123)')).toBe('Unknown employee (abc123)');
  });

  it('falls back to full names when two people would share a short name', () => {
    const named: Reference = {
      ...ref,
      employees: new Map([
        ['e-1', { name: 'Sam Lee', jobGuids: [], deleted: false }],
        ['e-2', { name: 'Sam Lin', jobGuids: [], deleted: false }],
        ['e-3', { name: 'Mara Chen', jobGuids: [], deleted: false }],
      ]),
    };
    const day = baseDay();
    day.timeEntries = [
      entry('e-1', 'j-srv', at('17:00'), at('22:00')),
      entry('e-2', 'j-srv', at('17:00'), at('22:00')),
      entry('e-3', 'j-bar', at('17:00'), at('22:00')),
    ];
    const names = buildTipoutInputs(day, named, config, CASH).input.periods.Dinner!.staff.map((s) => s.name);
    expect(names.sort()).toEqual(['Mara C.', 'Sam Lee', 'Sam Lin']);
  });
});

describe('zonedTimeToUtc', () => {
  it('handles daylight saving on both sides of the change', () => {
    expect(new Date(zonedTimeToUtc('2026-07-01', '16:00', TZ)).toISOString()).toBe('2026-07-01T23:00:00.000Z');
    expect(new Date(zonedTimeToUtc('2026-12-01', '16:00', TZ)).toISOString()).toBe('2026-12-02T00:00:00.000Z');
  });
});
