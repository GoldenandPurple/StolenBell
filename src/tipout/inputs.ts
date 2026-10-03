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
    /** Where card tips and auto-gratuity came from, and how they compare with the other source. */
    tips: {
      source: string;
      /** Shifts (or checks, for check-based sources) whose tips were shared between Lunch and Dinner. */
      spanningBothPeriods: { count: number; toLunch: number; toDinner: number };
      cardTipsOnShifts: Record<Period, number>;
      cardTipsOnChecks: Record<Period, number>;
      autoGratuityOnShifts: Record<Period, number>;
      autoGratuityOnChecks: Record<Period, number>;
      cashGratuityOnShifts: number;
    };
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
/** For matching job titles and categories: ignores case, spacing and punctuation ("Lead Bartender - ADMIN" = "lead bartender admin"). */
export const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const money = (amountCents: number) => `$${dollars(amountCents).toFixed(2)}`;
const overlapMs = (start: number, end: number, from: number, to: number) =>
  Math.max(0, Math.min(end, to) - Math.max(start, from));
const centsToDollars = (record: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(record)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => [key, dollars(value)]),
  );

/** "Mara Chen" -> "Mara C.". Single names, and fallback labels like "Unknown employee (…)", are kept as they are. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2 || full.includes('(')) return full.trim();
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

type Shares = Record<Period, number>;

const oneHot = (period: Period): Shares => (period === 'Lunch' ? { Lunch: 1, Dinner: 0 } : { Lunch: 0, Dinner: 1 });

/** Shares by how long the check was open in each period. */
function timeShares(start: number | undefined, end: number | undefined, dinnerStart: number, periodOf: (t: number) => Period): Shares | undefined {
  if (start !== undefined && end !== undefined && end > start) {
    return { Lunch: overlapMs(start, end, -Infinity, dinnerStart), Dinner: overlapMs(start, end, dinnerStart, Infinity) };
  }
  const instant = end ?? start;
  return instant === undefined ? undefined : oneHot(periodOf(instant));
}

/** Shares by the sales rung in each period (by when each item was added to the check). */
function itemShares(
  selections: { price?: number; voided?: boolean; createdDate?: string }[],
  checkStart: number | undefined,
  periodOf: (t: number) => Period,
): Shares | undefined {
  const shares: Shares = { Lunch: 0, Dinner: 0 };
  for (const selection of selections) {
    if (selection.voided) continue;
    const at = parseInstant(selection.createdDate) ?? checkStart;
    if (at !== undefined) shares[periodOf(at)] += Math.max(0, cents(selection.price));
  }
  return shares.Lunch + shares.Dinner > 0 ? shares : undefined;
}

/** Splits whole cents by share, largest remainder, so the parts always add back to the total. */
function splitCents(total: number, shares: Shares): [Period, number][] {
  const sum = shares.Lunch + shares.Dinner;
  const lunchExact = (total * shares.Lunch) / sum;
  let lunch = Math.floor(lunchExact);
  if (lunchExact - lunch >= 0.5) lunch += 1;
  return [
    ['Lunch', lunch],
    ['Dinner', total - lunch],
  ];
}

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

  // Orders: sales go to the period the order was opened in. Card tips and auto-gratuity are also
  // rebuilt from the checks here; they're used when cardTipSource is check-based, and otherwise only
  // to cross-check Toast's per-shift figures.
  const useShifts = config.cardTipSource === 'time_entries';
  const checkMethod = useShifts ? 'check_time' : config.cardTipSource;
  const splitChecks = { count: 0, lunchCents: 0, dinnerCents: 0 };
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
      const paidTimes = payments.map((payment) => parseInstant(payment.paidDate)).filter((t): t is number => t !== undefined);
      const checkStart = parseInstant(c.openedDate) ?? opened;
      const checkEnd = parseInstant(c.closedDate) ?? (paidTimes.length ? Math.max(...paidTimes) : undefined) ?? checkStart;
      // How this check's card tips and auto-gratuity are shared between Lunch and Dinner (see cardTipSource).
      const shares =
        checkMethod === 'payment'
          ? undefined
          : (checkMethod === 'check_items' ? itemShares(c.selections ?? [], checkStart, periodOf) : undefined) ??
            timeShares(checkStart, checkEnd, dinnerStart, periodOf);
      const paidAt = (payment: (typeof payments)[number]) => parseInstant(payment.paidDate) ?? parseInstant(c.closedDate) ?? opened;

      const gratuity = (c.appliedServiceCharges ?? [])
        .filter((charge) => charge.gratuity)
        .reduce((sum, charge) => sum + cents(charge.chargeAmount), 0);
      if (gratuity) {
        const firstPaid = paidTimes[0] ?? parseInstant(c.closedDate) ?? opened;
        const gratuityShares = shares ?? (firstPaid === undefined ? undefined : oneHot(periodOf(firstPaid)));
        if (!gratuityShares) undatedTipCents += gratuity;
        else for (const [period, amount] of splitCents(gratuity, gratuityShares)) acc[period].gratuityCents += amount;
      }

      let checkCardTips = 0;
      for (const payment of payments) {
        const tip = cents(payment.tipAmount);
        const type = (payment.type ?? 'UNKNOWN').toUpperCase();
        const paid = paidAt(payment);
        // Cash isn't pooled from Toast (the GM counts the till), so it's only reported, by payment time.
        if (type === 'CASH') {
          if (paid !== undefined) {
            acc[periodOf(paid)].cashSalesCents += cents(payment.amount);
            acc[periodOf(paid)].cashTipCents += tip;
          } else if (tip) undatedTipCents += tip;
          continue;
        }
        if (tip === 0) continue;
        const tipShares = shares ?? (paid === undefined ? undefined : oneHot(periodOf(paid)));
        if (!tipShares) {
          undatedTipCents += tip;
          continue;
        }
        if ((checkEnd ?? paid ?? Infinity) < lunchStart) earlyTipCents += tip;
        checkCardTips += tip;
        for (const [period, amount] of splitCents(tip, tipShares)) {
          acc[period].cardTipCents += amount;
          acc[period].cardTipsByType[type] = (acc[period].cardTipsByType[type] ?? 0) + amount;
        }
      }
      if (shares && shares.Lunch > 0 && shares.Dinner > 0 && checkCardTips + gratuity > 0) {
        const [[, lunch], [, dinner]] = splitCents(checkCardTips + gratuity, shares);
        splitChecks.count += 1;
        splitChecks.lunchCents += lunch;
        splitChecks.dinnerCents += dinner;
      }
    }
  }
  if (undatedTipCents && !useShifts) stop(`${money(undatedTipCents)} of tips have no payment time, so they can't be put in Lunch or Dinner.`);
  if (undatedOrders) stop(`${undatedOrders} order(s) with sales have no opened time, so their sales can't be put in Lunch or Dinner.`);
  if (earlyTipCents && !useShifts) check(`${money(earlyTipCents)} of card tips were on checks closed before ${config.periods.lunchStart}; they are counted in Lunch.`);

  // Time entries: hours split at the period boundaries, minus unpaid breaks.
  const roleMap = new Map(Object.entries(config.roles).map(([job, role]) => [normalize(job), role]));
  const jobMapping: Record<string, string> = {};
  const unmapped = new Set<string>();
  const unlistedJobs = new Set<string>();
  const windows: Record<Period, [number, number]> = { Lunch: [lunchStart, dinnerStart], Dinner: [dinnerStart, Infinity] };

  // Card tips and auto-gratuity as Toast credited them to each shift (its own allocation).
  const shiftTips: Record<Period, { card: number; gratuity: number }> = { Lunch: { card: 0, gratuity: 0 }, Dinner: { card: 0, gratuity: 0 } };
  const splitShifts = { count: 0, lunchCents: 0, dinnerCents: 0 };
  let cashGratuityOnShifts = 0;
  let undatedShiftTipCents = 0;

  for (const entry of day.timeEntries) {
    if (entry.deleted) continue;
    const guid = entry.employeeReference?.guid;
    if (!guid) continue;
    const job = jobTitle(ref, entry);
    const listed = roleMap.get(normalize(job));
    const role = listed ?? (config.otherJobs === 'stop' ? undefined : config.otherJobs);
    jobMapping[job] = listed ?? (role ? `${role} (not listed; otherJobs)` : 'UNMAPPED');
    if (!listed && role) unlistedJobs.add(job);
    const name = staffName(ref, guid);
    const clockIn = parseInstant(entry.inDate);
    const clockOut = parseInstant(entry.outDate);

    let unfinishedBreak = false;
    const unpaidBreaks: [number, number][] = [];
    for (const breakEntry of entry.breaks ?? []) {
      if (breakEntry.paid || breakEntry.missed) continue;
      const start = parseInstant(breakEntry.inDate);
      const end = parseInstant(breakEntry.outDate);
      if (start === undefined || end === undefined) {
        unfinishedBreak = true;
        continue;
      }
      if (clockIn !== undefined && clockOut !== undefined) unpaidBreaks.push([Math.max(start, clockIn), Math.min(end, clockOut)]);
    }
    const workedIn = (from: number, to: number) =>
      clockIn === undefined || clockOut === undefined
        ? 0
        : overlapMs(clockIn, clockOut, from, to) -
          unpaidBreaks.reduce((sum, [start, end]) => sum + (end > start ? overlapMs(start, end, from, to) : 0), 0);

    // Every shift's tips belong in the pool, whatever the job, so this comes before the role checks.
    const card = cents(entry.nonCashTips);
    const gratuity = cents(entry.nonCashGratuityServiceCharges);
    cashGratuityOnShifts += cents(entry.cashGratuityServiceCharges);
    if (card || gratuity) {
      const worked = workedIn(-Infinity, Infinity);
      const shares: Shares | undefined =
        worked > 0
          ? { Lunch: workedIn(-Infinity, dinnerStart), Dinner: workedIn(dinnerStart, Infinity) }
          : clockIn !== undefined
            ? oneHot(periodOf(clockIn))
            : undefined;
      if (!shares) undatedShiftTipCents += card + gratuity;
      else {
        for (const [period, amount] of splitCents(card, shares)) shiftTips[period].card += amount;
        for (const [period, amount] of splitCents(gratuity, shares)) shiftTips[period].gratuity += amount;
        if (shares.Lunch > 0 && shares.Dinner > 0) {
          const [[, lunch], [, dinner]] = splitCents(card + gratuity, shares);
          splitShifts.count += 1;
          splitShifts.lunchCents += lunch;
          splitShifts.dinnerCents += dinner;
        }
      }
    }

    if (!role) {
      unmapped.add(job);
      continue;
    }
    if (role === 'ignore') continue;
    if (clockIn === undefined) {
      stop(`${name} (${job}) has a time entry with no clock-in time.`);
      continue;
    }
    if (clockOut === undefined) {
      stop(`${name} (${job}) is still clocked in (since ${wallClock(clockIn, timeZone)}). Clock them out in Toast first.`);
      continue;
    }
    if (unfinishedBreak) check(`${name} (${job}) has an unfinished break; it was not deducted.`);

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
  if (unlistedJobs.size) {
    check(
      `Not listed in the tip-out config, so treated as ${config.otherJobs === 'ignore' ? 'not tipped' : config.otherJobs}: ${[...unlistedJobs].join(', ')}. ` +
        `If that's wrong, add them under roles.`,
    );
  }

  const checkTips: Record<Period, { card: number; gratuity: number }> = {
    Lunch: { card: acc.Lunch.cardTipCents, gratuity: acc.Lunch.gratuityCents },
    Dinner: { card: acc.Dinner.cardTipCents, gratuity: acc.Dinner.gratuityCents },
  };
  if (useShifts) {
    for (const period of PERIODS) {
      acc[period].cardTipCents = shiftTips[period].card;
      acc[period].gratuityCents = shiftTips[period].gratuity;
    }
    if (undatedShiftTipCents) stop(`${money(undatedShiftTipCents)} of tips are on shifts with no clock-in time, so they can't be put in Lunch or Dinner.`);
    const onShifts = shiftTips.Lunch.card + shiftTips.Dinner.card + undatedShiftTipCents;
    const onChecks = checkTips.Lunch.card + checkTips.Dinner.card;
    if (Math.abs(onShifts - onChecks) > 100) {
      check(
        `Card tips on Toast shifts total ${money(onShifts)}, but card tips on the day's checks total ${money(onChecks)}. ` +
          `The tip-out uses the shift figures (Toast's allocation); a gap usually means a tip was adjusted after the shift closed, or someone took payments without clocking in.`,
      );
    }
  }

  // Names are "First L." on the sheet. The engine keys payouts by name, so if two people would get
  // the same short name they're shown in full, and if their full names match too, with their ID.
  const guids = [...new Set(PERIODS.flatMap((period) => [...acc[period].hours.values()].map((slot) => slot.guid)))];
  const countBy = (name: (guid: string) => string) => {
    const counts = new Map<string, number>();
    for (const guid of guids) counts.set(name(guid), (counts.get(name(guid)) ?? 0) + 1);
    return counts;
  };
  const shortCounts = countBy((guid) => shortName(staffName(ref, guid)));
  const fullCounts = countBy((guid) => staffName(ref, guid));
  const displayName = (guid: string) => {
    const full = staffName(ref, guid);
    const short = shortName(full);
    if (shortCounts.get(short)! === 1) return short;
    return fullCounts.get(full)! > 1 ? `${full} (${guid.slice(0, 6)})` : full;
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
      tips: {
        source: config.cardTipSource,
        spanningBothPeriods: {
          count: (useShifts ? splitShifts : splitChecks).count,
          toLunch: dollars((useShifts ? splitShifts : splitChecks).lunchCents),
          toDinner: dollars((useShifts ? splitShifts : splitChecks).dinnerCents),
        },
        cardTipsOnShifts: { Lunch: dollars(shiftTips.Lunch.card), Dinner: dollars(shiftTips.Dinner.card) },
        cardTipsOnChecks: { Lunch: dollars(checkTips.Lunch.card), Dinner: dollars(checkTips.Dinner.card) },
        autoGratuityOnShifts: { Lunch: dollars(shiftTips.Lunch.gratuity), Dinner: dollars(shiftTips.Dinner.gratuity) },
        autoGratuityOnChecks: { Lunch: dollars(checkTips.Lunch.gratuity), Dinner: dollars(checkTips.Dinner.gratuity) },
        cashGratuityOnShifts: dollars(cashGratuityOnShifts),
      },
      periodWindows: { Lunch: `${clock(lunchStart)}–${clock(dinnerStart)}`, Dinner: `${clock(dinnerStart)}–close` },
      perPeriod,
      jobMapping,
    },
  };
}
