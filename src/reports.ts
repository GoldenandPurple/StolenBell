import {
  allOrderFacts,
  buildStaffDays,
  cents,
  dollars,
  entryHours,
  entryTipsCents,
  jobTitle,
  liveEntries,
  openShifts,
  staffName,
} from './data/analytics.js';
import { businessDates, isoFromBusinessDate } from './data/dates.js';
import type { ToastRepository } from './data/repository.js';
import { calculateTipOut, round2, type EmployeeTipOut, type RuleResult } from './tipout/engine.js';
import type { TipRule, TipSources } from './tipout/rules.js';

export interface DateRange {
  startDate: string;
  endDate?: string | undefined;
}

const period = (range: DateRange) => ({ startDate: range.startDate, endDate: range.endDate ?? range.startDate });

function sumBy<T>(rows: T[], key: (row: T) => string, init: () => Record<string, number>, add: (acc: Record<string, number>, row: T) => void) {
  const groups = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const name = key(row);
    let acc = groups.get(name);
    if (!acc) groups.set(name, (acc = init()));
    add(acc, row);
  }
  return groups;
}

export type SalesGroupBy = 'total' | 'day' | 'server' | 'revenue_center' | 'sales_category';

export async function salesReport(repo: ToastRepository, range: DateRange, groupBy: SalesGroupBy) {
  const dates = businessDates(range.startDate, range.endDate);
  const [ref, days] = await Promise.all([repo.reference(), repo.daysFor(dates)]);
  const orders = allOrderFacts(days, ref);

  const zero = () => ({ orders: 0, checks: 0, guests: 0, gross: 0, net: 0, tax: 0, tips: 0, gratuity: 0 });
  const add = (acc: Record<string, number>, order: (typeof orders)[number]) => {
    acc.orders! += 1;
    acc.checks! += order.checks;
    acc.guests! += order.guests;
    acc.gross! += order.grossSalesCents;
    acc.net! += order.netSalesCents;
    acc.tax! += order.taxCents;
    acc.tips! += order.tipsCents;
    acc.gratuity! += order.gratuityCents;
  };
  const shape = (acc: Record<string, number>) => ({
    orders: acc.orders!,
    checks: acc.checks!,
    guests: acc.guests!,
    grossSales: dollars(acc.gross!),
    discounts: dollars(acc.gross! - acc.net!),
    netSales: dollars(acc.net!),
    tax: dollars(acc.tax!),
    tips: dollars(acc.tips!),
    gratuity: dollars(acc.gratuity!),
    averageCheck: acc.checks ? dollars(acc.net! / acc.checks) : 0,
    netSalesPerGuest: acc.guests ? dollars(acc.net! / acc.guests) : null,
  });

  const totals = zero();
  orders.forEach((order) => add(totals, order));
  const result: Record<string, unknown> = { period: period(range), totals: shape(totals) };

  if (groupBy === 'sales_category') {
    const byCategory = new Map<string, number>();
    for (const order of orders) {
      for (const [category, amount] of Object.entries(order.salesByCategoryCents)) {
        byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
      }
    }
    result.groups = [...byCategory]
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({
        salesCategory: category,
        netSales: dollars(amount),
        shareOfNetSales: totals.net ? round2((amount / totals.net) * 100) : 0,
      }));
  } else if (groupBy !== 'total') {
    const key =
      groupBy === 'day'
        ? (order: (typeof orders)[number]) => order.businessDate
        : groupBy === 'server'
          ? (order: (typeof orders)[number]) => staffName(ref, order.serverGuid)
          : (order: (typeof orders)[number]) => order.revenueCenter;
    const groups = sumBy(orders, key, zero, add);
    const label = groupBy === 'day' ? 'businessDate' : groupBy === 'server' ? 'server' : 'revenueCenter';
    result.groups = [...groups]
      .sort((a, b) => (groupBy === 'day' ? a[0].localeCompare(b[0]) : b[1].net! - a[1].net!))
      .map(([name, acc]) => ({ [label]: name, ...shape(acc) }));
  }
  return result;
}

export async function topItemsReport(repo: ToastRepository, range: DateRange, limit: number) {
  const dates = businessDates(range.startDate, range.endDate);
  const [ref, days] = await Promise.all([repo.reference(), repo.daysFor(dates)]);
  const items = new Map<string, { quantity: number; net: number }>();
  for (const order of allOrderFacts(days, ref)) {
    for (const item of order.items) {
      const acc = items.get(item.name) ?? { quantity: 0, net: 0 };
      acc.quantity += item.quantity;
      acc.net += item.netSalesCents;
      items.set(item.name, acc);
    }
  }
  return {
    period: period(range),
    items: [...items]
      .sort((a, b) => b[1].net - a[1].net)
      .slice(0, limit)
      .map(([name, acc]) => ({ item: name, quantity: round2(acc.quantity), netSales: dollars(acc.net) })),
  };
}

export type LaborGroupBy = 'employee' | 'job' | 'day';

export async function laborReport(repo: ToastRepository, range: DateRange, groupBy: LaborGroupBy, includeWages: boolean) {
  const dates = businessDates(range.startDate, range.endDate);
  const [ref, days] = await Promise.all([repo.reference(), repo.daysFor(dates)]);
  const rows = days.flatMap((day) =>
    liveEntries(day).map((entry) => ({
      employee: staffName(ref, entry.employeeReference?.guid),
      job: jobTitle(ref, entry),
      day: isoFromBusinessDate(day.businessDate),
      regular: entry.regularHours ?? 0,
      overtime: entry.overtimeHours ?? 0,
      wageCents: cents((entry.hourlyWage ?? 0) * ((entry.regularHours ?? 0) + 1.5 * (entry.overtimeHours ?? 0))),
    })),
  );
  const key = (row: (typeof rows)[number]) => row[groupBy];
  const groups = sumBy(
    rows,
    key,
    () => ({ shifts: 0, regular: 0, overtime: 0, wage: 0 }),
    (acc, row) => {
      acc.shifts! += 1;
      acc.regular! += row.regular;
      acc.overtime! += row.overtime;
      acc.wage! += row.wageCents;
    },
  );
  const netSalesCents = includeWages ? allOrderFacts(days, ref).reduce((sum, order) => sum + order.netSalesCents, 0) : 0;
  const totalWage = rows.reduce((sum, row) => sum + row.wageCents, 0);
  return {
    period: period(range),
    totals: {
      shifts: rows.length,
      regularHours: round2(rows.reduce((sum, row) => sum + row.regular, 0)),
      overtimeHours: round2(rows.reduce((sum, row) => sum + row.overtime, 0)),
      ...(includeWages
        ? {
            estimatedWageCost: dollars(totalWage),
            netSales: dollars(netSalesCents),
            laborCostPercent: netSalesCents ? round2((totalWage / netSalesCents) * 100) : null,
          }
        : {}),
    },
    groups: [...groups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, acc]) => ({
        [groupBy]: name,
        shifts: acc.shifts!,
        regularHours: round2(acc.regular!),
        overtimeHours: round2(acc.overtime!),
        totalHours: round2(acc.regular! + acc.overtime!),
        ...(includeWages ? { estimatedWageCost: dollars(acc.wage!) } : {}),
      })),
    stillClockedIn: openShifts(days, ref),
    notes: includeWages
      ? ['Wage cost is hourly wage x hours with overtime at 1.5x; it excludes salaried staff, taxes and benefits.']
      : [],
  };
}

export async function tipsReport(repo: ToastRepository, range: DateRange) {
  const dates = businessDates(range.startDate, range.endDate);
  const [ref, days] = await Promise.all([repo.reference(), repo.daysFor(dates)]);
  const all = { cardTips: true, declaredCashTips: true, gratuities: true };
  const rows = days.flatMap((day) =>
    liveEntries(day).map((entry) => ({
      employee: staffName(ref, entry.employeeReference?.guid),
      job: jobTitle(ref, entry),
      hours: entryHours(entry),
      card: cents(entry.nonCashTips),
      cash: cents(entry.declaredCashTips),
      gratuity: cents(entry.cashGratuityServiceCharges) + cents(entry.nonCashGratuityServiceCharges),
      total: entryTipsCents(entry, all),
    })),
  );
  const groups = sumBy(
    rows,
    (row) => `${row.employee}\u0000${row.job}`,
    () => ({ hours: 0, card: 0, cash: 0, gratuity: 0, total: 0 }),
    (acc, row) => {
      acc.hours! += row.hours;
      acc.card! += row.card;
      acc.cash! += row.cash;
      acc.gratuity! += row.gratuity;
      acc.total! += row.total;
    },
  );
  return {
    period: period(range),
    note: 'Tips before any tip-out, as recorded on Toast time entries.',
    totals: {
      cardTips: dollars(rows.reduce((sum, row) => sum + row.card, 0)),
      declaredCashTips: dollars(rows.reduce((sum, row) => sum + row.cash, 0)),
      gratuities: dollars(rows.reduce((sum, row) => sum + row.gratuity, 0)),
      total: dollars(rows.reduce((sum, row) => sum + row.total, 0)),
    },
    employees: [...groups]
      .map(([name, acc]) => {
        const [employee, job] = name.split('\u0000');
        return {
          employee,
          job,
          hours: round2(acc.hours!),
          cardTips: dollars(acc.card!),
          declaredCashTips: dollars(acc.cash!),
          gratuities: dollars(acc.gratuity!),
          totalTips: dollars(acc.total!),
          tipsPerHour: acc.hours ? dollars(acc.total! / acc.hours) : null,
        };
      })
      .sort((a, b) => b.totalTips - a.totalTips),
    stillClockedIn: openShifts(days, ref),
  };
}

/** Runs the tip-out for each business day separately (tip-outs settle per shift-day), then totals per employee. */
export async function tipOutReport(repo: ToastRepository, range: DateRange, rules: TipRule[], sources: TipSources) {
  const dates = businessDates(range.startDate, range.endDate);
  const [ref, days] = await Promise.all([repo.reference(), repo.daysFor(dates)]);

  const totals = new Map<string, EmployeeTipOut & { paidByRule: Map<string, number>; receivedByRule: Map<string, number> }>();
  const ruleTotals = new Map<string, number>();
  const warnings: string[] = [];
  const perDay: { businessDate: string; pots: { rule: string; pot: number; skipped?: string }[] }[] = [];

  for (const day of days) {
    const result = calculateTipOut(buildStaffDays(day, ref, sources), rules);
    const date = isoFromBusinessDate(day.businessDate);
    warnings.push(...result.warnings.map((warning) => `${date}: ${warning}`));
    perDay.push({ businessDate: date, pots: result.rules.map(potSummary) });
    for (const rule of result.rules) ruleTotals.set(rule.rule, (ruleTotals.get(rule.rule) ?? 0) + rule.potCents);
    for (const employee of result.employees) {
      const acc =
        totals.get(employee.employeeGuid) ??
        { ...employee, jobs: [], hours: 0, netSalesCents: 0, tipsEarnedCents: 0, paidOutCents: 0, receivedCents: 0, finalTipsCents: 0, paidOut: [], received: [], paidByRule: new Map(), receivedByRule: new Map() };
      acc.jobs = [...new Set([...acc.jobs, ...employee.jobs])];
      acc.hours = round2(acc.hours + employee.hours);
      acc.netSalesCents += employee.netSalesCents;
      acc.tipsEarnedCents += employee.tipsEarnedCents;
      acc.paidOutCents += employee.paidOutCents;
      acc.receivedCents += employee.receivedCents;
      acc.finalTipsCents += employee.finalTipsCents;
      for (const item of employee.paidOut) acc.paidByRule.set(item.rule, (acc.paidByRule.get(item.rule) ?? 0) + item.amountCents);
      for (const item of employee.received) acc.receivedByRule.set(item.rule, (acc.receivedByRule.get(item.rule) ?? 0) + item.amountCents);
      totals.set(employee.employeeGuid, acc);
    }
  }

  const byRule = (map: Map<string, number>) => Object.fromEntries([...map].map(([rule, amount]) => [rule, dollars(amount)]));
  return {
    period: period(range),
    rulesApplied: rules.map(describeRule),
    tipSources: sources,
    employees: [...totals.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((employee) => ({
        employee: employee.name,
        jobs: employee.jobs,
        hours: employee.hours,
        netSales: dollars(employee.netSalesCents),
        tipsEarned: dollars(employee.tipsEarnedCents),
        tipOutPaid: dollars(employee.paidOutCents),
        tipOutReceived: dollars(employee.receivedCents),
        finalTips: dollars(employee.finalTipsCents),
        finalTipsPerHour: employee.hours ? dollars(employee.finalTipsCents / employee.hours) : null,
        paidByRule: byRule(employee.paidByRule),
        receivedByRule: byRule(employee.receivedByRule),
      })),
    ruleTotals: Object.fromEntries([...ruleTotals].map(([rule, amount]) => [rule, dollars(amount)])),
    days: dates.length > 1 ? perDay : undefined,
    skipped: perDay.flatMap((day) => day.pots.filter((pot) => pot.skipped).map((pot) => `${day.businessDate} ${pot.rule}: ${pot.skipped}`)),
    stillClockedIn: openShifts(days, ref),
    warnings,
  };
}

function potSummary(rule: RuleResult) {
  return { rule: rule.rule, pot: dollars(rule.potCents), ...(rule.skippedReason ? { skipped: rule.skippedReason } : {}) };
}

export function describeRule(rule: TipRule): string {
  const basis =
    rule.basis === 'sales'
      ? `${rule.salesCategories ? `${rule.salesCategories.join('/')} ` : 'net '}sales`
      : rule.basis === 'tips'
        ? 'tips earned'
        : 'tips remaining after earlier rules';
  const split = rule.split === 'equal' ? 'split equally' : 'split by hours worked';
  const points = rule.points ? ` (weights: ${Object.entries(rule.points).map(([job, value]) => `${job} ${value}`).join(', ')})` : '';
  return `${rule.name}: ${rule.from.join('/')} pay ${rule.percent}% of ${basis} to ${rule.to.join('/')}, ${split}${points}${rule.capAtTips ? '; capped at tips held' : ''}`;
}
