import { cents, dollars, jobTitle, paymentCounts, staffName } from '../data/analytics.js';
import { isoFromBusinessDate } from '../data/dates.js';
import type { DayData, Reference } from '../data/repository.js';
import { assertTimeZone, parseInstant, wallClock, zonedTimeToUtc } from '../data/zoned.js';
import type { TipoutConfig, TipoutRole } from './config.js';

/**
 * Turns one Toast business day into the input document for the Stolen Bell
 * tip-out skill (skills/stolen-bell-tipout/scripts/tipout.py). This only
 * buckets and sums Toast data; the tip-out rules live in that script.
 */

export type Period = 'Lunch' | 'Dinner';
const PERIODS: Period[] = ['Lunch', 'Dinner'];

export interface PeriodInput {
  pool_card_tips: number;
  auto_gratuity: number;
  cash_tips_manual: number | null;
  /** For the Cash Out form only; the engine ignores it. Cash payments excluding tips. */
  cash_sales: number;
  gross_food_sales: number;
  net_sales: number;
  staff: { name: string; role: TipoutRole; hours: number }[];
}

export interface TipoutInputDocument {
  business_date: string;
  periods: Partial<Record<Period, PeriodInput>>;
}

export interface Issue {
  /** stop: don't run the engine until a person resolves it. check: show it to the GM. */
  severity: 'stop' | 'check';
  message: string;
}

export interface PeriodDetails {
  orders: number;
  autoGratuity: number;
  cashSales: number;
  cardTipsByPaymentType: Record<string, number>;
  cashTipsRecordedInToast: number;
  salesByCategory: Record<string, number>;
}

export interface TipoutInputs {
  ready: boolean;
  issues: Issue[];
  input: TipoutInputDocument;
  details: {
    timeZone: string;
    periodWindows: Record<Period, string>;
    perPeriod: Record<Period, PeriodDetails>;
    jobMapping: Record<string, string>;
  };
}

export type CashEntry = Partial<Record<Period, number | undefined>>;

interface Accumulator {
  orders: number;
  netCents: number;
  foodCents: number;
  cardTipCents: number;
  gratuityCents: number;
  cashSalesCents: number;
  cardTipsByType: Record<string, number>;
  cashTipCents: number;
  salesByCategory: Record<string, number>;
  /** keyed by employee guid + role */
  hours: Map<string, { guid: string; role: TipoutRole; hours: number }>;
}

const blank = (): Accumulator => ({
  orders: 0,
  netCents: 0,
  foodCents: 0,
  cardTipCents: 0,
  gratuityCents: 0,
  cashSalesCents: 0,
  cardTipsByType: {},
  cashTipCents: 0,
  salesByCategory: {},
  hours: new Map(),
});

const HOUR_MS = 3_600_000;
const normalize = (value: string) => value.trim().toLowerCase();
const money = (amountCents: number) => `$${dollars(amountCents).toFixed(2)}`;
const overlapMs = (start: number, end: number, from: number, to: number) =>
  Math.max(0, Math.min(end, to) - Math.max(start, from));
const centsToDollars = (record: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(record)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => [key, dollars(value)]),
  );

export function buildTipoutInputs(day: DayData, ref: Reference, config: TipoutConfig, cash: CashEntry = {}): TipoutInputs {
  const businessDate = isoFromBusinessDate(day.businessDate);
  const issues: Issue[] = [];
  const stop = (message: string) => issues.push({ severity: 'stop', message });
  const check = (message: string) => issues.push({ severity: 'check', message });

  const timeZone = config.timeZone ?? ref.restaurant.general?.timeZone;
  if (!timeZone) {
    throw new Error('Toast did not return the restaurant time zone. Set timeZone in the tip-out config.');
  }
  assertTimeZone(timeZone);
  const lunchStart = zonedTimeToUtc(businessDate, config.periods.lunchStart, timeZone);
  const dinnerStart = zonedTimeToUtc(businessDate, config.periods.dinnerStart, timeZone);
  const periodOf = (instant: number): Period => (instant < dinnerStart ? 'Lunch' : 'Dinner');
  const acc: Record<Period, Accumulator> = { Lunch: blank(), Dinner: blank() };

  const foodCategories = new Set(config.foodCategories.map(normalize));
  const toastCategories = [...new Set(ref.salesCategories.values())];
  const missingFood = config.foodCategories.filter(
    (category) => !toastCategories.some((name) => normalize(name) === normalize(category)),
  );
  if (missingFood.length === config.foodCategories.length) {
    stop(
      `None of the food categories (${config.foodCategories.join(', ')}) exist in Toast, so food sales would be $0. ` +
        `Toast's categories are: ${toastCategories.join(', ')}.`,
    );
  } else if (missingFood.length) {
    check(`Food categories not found in Toast and ignored: ${missingFood.join(', ')}.`);
  }

  // Orders: sales go to the period the order was opened in; tips to the period they were paid in.
  let earlyTipCents = 0;
  let undatedTipCents = 0;
  let undatedOrders = 0;
  for (const order of day.orders) {
    if (order.voided || order.deleted) continue;
    const checks = (order.checks ?? []).filter((c) => !c.voided && !c.deleted);
    if (checks.length === 0) continue;
    const opened = parseInstant(order.openedDate) ?? parseInstant(checks[0]!.openedDate);

    let orderNet = 0;
    let orderFood = 0;
    const orderCategories: Record<string, number> = {};
    for (const c of checks) {
      for (const selection of c.selections ?? []) {
        if (selection.voided) continue;
        const net = cents(selection.price);
        const category =
          (selection.salesCategory && ref.salesCategories.get(selection.salesCategory.guid)) || 'Uncategorized';
        orderNet += net;
        orderCategories[category] = (orderCategories[category] ?? 0) + net;
        // Gross food is before discounts, matching Toast's gross sales; net sales is after.
        if (foodCategories.has(normalize(category))) orderFood += cents(selection.preDiscountPrice ?? selection.price);
      }
    }
    if (opened === undefined) {
      if (orderNet !== 0) undatedOrders += 1;
    } else {
      const bucket = acc[periodOf(opened)];
      bucket.orders += 1;
      bucket.netCents += orderNet;
      bucket.foodCents += orderFood;
      for (const [category, amount] of Object.entries(orderCategories)) {
        bucket.salesByCategory[category] = (bucket.salesByCategory[category] ?? 0) + amount;
      }
    }

    for (const c of checks) {
      const payments = (c.payments ?? []).filter(paymentCounts);
      const checkPaid =
        payments.map((payment) => parseInstant(payment.paidDate)).find((instant) => instant !== undefined) ??
        parseInstant(c.closedDate) ??
        opened;
      // Auto-gratuity is a service charge on the check, so it goes to the period the check was paid in.
      const gratuity = (c.appliedServiceCharges ?? [])
        .filter((charge) => charge.gratuity)
        .reduce((sum, charge) => sum + cents(charge.chargeAmount), 0);
      if (gratuity) {
        if (checkPaid === undefined) undatedTipCents += gratuity;
        else acc[periodOf(checkPaid)].gratuityCents += gratuity;
      }

      for (const payment of payments) {
        const tip = cents(payment.tipAmount);
        const type = (payment.type ?? 'UNKNOWN').toUpperCase();
        const paid = parseInstant(payment.paidDate) ?? parseInstant(c.closedDate) ?? opened;
        if (type === 'CASH' && paid !== undefined) acc[periodOf(paid)].cashSalesCents += cents(payment.amount);
        if (tip === 0) continue;
        if (paid === undefined) {
          undatedTipCents += tip;
          continue;
        }
        const bucket = acc[periodOf(paid)];
        if (type === 'CASH') {
          bucket.cashTipCents += tip;
          continue;
        }
        if (paid < lunchStart) earlyTipCents += tip;
        bucket.cardTipCents += tip;
        bucket.cardTipsByType[type] = (bucket.cardTipsByType[type] ?? 0) + tip;
      }
    }
  }
  if (undatedTipCents) stop(`${money(undatedTipCents)} of tips have no payment time, so they can't be put in Lunch or Dinner.`);
  if (undatedOrders) stop(`${undatedOrders} order(s) with sales have no opened time, so their sales can't be put in Lunch or Dinner.`);
  if (earlyTipCents) check(`${money(earlyTipCents)} of card tips were paid before ${config.periods.lunchStart}; they are counted in Lunch.`);

  // Time entries: hours split at the period boundaries, minus unpaid breaks.
  const roleMap = new Map(Object.entries(config.roles).map(([job, role]) => [normalize(job), role]));
  const jobMapping: Record<string, string> = {};
  const unmapped = new Set<string>();
  const windows: Record<Period, [number, number]> = { Lunch: [lunchStart, dinnerStart], Dinner: [dinnerStart, Infinity] };

  for (const entry of day.timeEntries) {
    if (entry.deleted) continue;
    const guid = entry.employeeReference?.guid;
    if (!guid) continue;
    const job = jobTitle(ref, entry);
    const role = roleMap.get(normalize(job));
    jobMapping[job] = role ?? 'UNMAPPED';
    if (!role) {
      unmapped.add(job);
      continue;
    }
    if (role === 'ignore') continue;

    const name = staffName(ref, guid);
    const clockIn = parseInstant(entry.inDate);
    const clockOut = parseInstant(entry.outDate);
    if (clockIn === undefined) {
      stop(`${name} (${job}) has a time entry with no clock-in time.`);
      continue;
    }
    if (clockOut === undefined) {
      stop(`${name} (${job}) is still clocked in (since ${wallClock(clockIn, timeZone)}). Clock them out in Toast first.`);
      continue;
    }

    const unpaidBreaks: [number, number][] = [];
    for (const breakEntry of entry.breaks ?? []) {
      if (breakEntry.paid || breakEntry.missed) continue;
      const start = parseInstant(breakEntry.inDate);
      const end = parseInstant(breakEntry.outDate);
      if (start === undefined || end === undefined) {
        check(`${name} (${job}) has an unfinished break; it was not deducted.`);
        continue;
      }
      unpaidBreaks.push([Math.max(start, clockIn), Math.min(end, clockOut)]);
    }
    const workedIn = (from: number, to: number) =>
      overlapMs(clockIn, clockOut, from, to) -
      unpaidBreaks.reduce((sum, [start, end]) => sum + (end > start ? overlapMs(start, end, from, to) : 0), 0);

    for (const period of PERIODS) {
      const ms = workedIn(...windows[period]);
      if (ms <= 0) continue;
      const key = `${guid}|${role}`;
      const slot = acc[period].hours.get(key) ?? { guid, role, hours: 0 };
      slot.hours += ms / HOUR_MS;
      acc[period].hours.set(key, slot);
    }

    const early = workedIn(-Infinity, lunchStart);
    if (early > 0 && role !== 'Kitchen') {
      check(`${name} (${job}) worked ${(early / HOUR_MS).toFixed(2)} h before ${config.periods.lunchStart}; those hours count toward neither period.`);
    }
    const toastHours = (entry.regularHours ?? 0) + (entry.overtimeHours ?? 0);
    const computed = workedIn(-Infinity, Infinity) / HOUR_MS;
    if (toastHours > 0 && Math.abs(toastHours - computed) > 0.1) {
      check(`${name} (${job}): clock times give ${computed.toFixed(2)} h but Toast shows ${toastHours.toFixed(2)} h payable. Check for edited punches.`);
    }
  }
  for (const job of unmapped) {
    stop(`Toast job "${job}" isn't mapped to a tip-out role. Add it under roles in the tip-out config (or map it to "ignore").`);
  }

  // The engine keys payouts by name, so two employees with the same name get their ID appended.
  const guids = new Set(PERIODS.flatMap((period) => [...acc[period].hours.values()].map((slot) => slot.guid)));
  const nameCounts = new Map<string, number>();
  for (const guid of guids) nameCounts.set(staffName(ref, guid), (nameCounts.get(staffName(ref, guid)) ?? 0) + 1);
  const displayName = (guid: string) => {
    const base = staffName(ref, guid);
    return nameCounts.get(base)! > 1 ? `${base} (${guid.slice(0, 6)})` : base;
  };

  const periods: Partial<Record<Period, PeriodInput>> = {};
  for (const period of PERIODS) {
    const bucket = acc[period];
    const cashEntered = cash[period];
    if (bucket.orders === 0 && bucket.cardTipCents === 0 && bucket.gratuityCents === 0 && bucket.hours.size === 0 && !cashEntered) continue;
    periods[period] = {
      pool_card_tips: dollars(bucket.cardTipCents),
      auto_gratuity: dollars(bucket.gratuityCents),
      cash_tips_manual: cashEntered ?? null,
      cash_sales: dollars(bucket.cashSalesCents),
      gross_food_sales: dollars(bucket.foodCents),
      net_sales: dollars(bucket.netCents),
      staff: [...bucket.hours.values()]
        .map((slot) => ({ name: displayName(slot.guid), role: slot.role, hours: Math.round(slot.hours * 100) / 100 }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)),
    };
    if (bucket.netCents > 0 && bucket.cardTipCents === 0 && bucket.gratuityCents === 0) {
      stop(`${period} has ${money(bucket.netCents)} in sales but $0 in card tips. Check tips in Toast before running tip-out.`);
    }
    if (cashEntered === undefined) {
      stop(
        `Enter the ${period} cash tip count (${period === 'Lunch' ? 'till count at the 4:00 changeover' : 'till count at close'}). ` +
          `Use 0 if there was none.` +
          (bucket.cashTipCents ? ` For reference, ${money(bucket.cashTipCents)} of cash tips were entered on Toast payments.` : ''),
      );
    }
  }
  if (!periods.Lunch && !periods.Dinner) stop('Toast returned no orders, tips or time entries for this day.');

  const clock = (instant: number) => wallClock(instant, timeZone);
  const perPeriod = {} as Record<Period, PeriodDetails>;
  for (const period of PERIODS) {
    perPeriod[period] = {
      orders: acc[period].orders,
      autoGratuity: dollars(acc[period].gratuityCents),
      cashSales: dollars(acc[period].cashSalesCents),
      cardTipsByPaymentType: centsToDollars(acc[period].cardTipsByType),
      cashTipsRecordedInToast: dollars(acc[period].cashTipCents),
      salesByCategory: centsToDollars(acc[period].salesByCategory),
    };
  }

  return {
    ready: !issues.some((issue) => issue.severity === 'stop'),
    issues,
    input: { business_date: businessDate, periods },
    details: {
      timeZone,
      periodWindows: { Lunch: `${clock(lunchStart)}–${clock(dinnerStart)}`, Dinner: `${clock(dinnerStart)}–close` },
      perPeriod,
      jobMapping,
    },
  };
}
