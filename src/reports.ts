import {
  allOrderFacts,
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

export interface DateRange {
  startDate: string;
  endDate?: string | undefined;
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

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
  const rows = days.flatMap((day) =>
    liveEntries(day).map((entry) => ({
      employee: staffName(ref, entry.employeeReference?.guid),
      job: jobTitle(ref, entry),
      hours: entryHours(entry),
      card: cents(entry.nonCashTips),
      cash: cents(entry.declaredCashTips),
      gratuity: cents(entry.cashGratuityServiceCharges) + cents(entry.nonCashGratuityServiceCharges),
      total: entryTipsCents(entry),
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
