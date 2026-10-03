import type { ToastOrder, ToastPayment, ToastTimeEntry } from '../toast/types.js';
import { isoFromBusinessDate } from './dates.js';
import type { DayData, Reference } from './repository.js';

export const cents = (dollars: number | undefined | null) => Math.round((dollars ?? 0) * 100);
export const dollars = (amountCents: number) => Math.round(amountCents) / 100;

const UNASSIGNED = 'Unassigned';
const VOID_PAYMENT_STATUSES = new Set(['VOIDED', 'DENIED', 'CANCELLED', 'ERROR']);

/** Sales facts for one order, in cents. Voided/deleted orders and checks are excluded. */
export interface OrderFacts {
  businessDate: string; // YYYY-MM-DD
  serverGuid: string | undefined;
  revenueCenter: string;
  guests: number;
  checks: number;
  grossSalesCents: number;
  netSalesCents: number;
  taxCents: number;
  tipsCents: number;
  gratuityCents: number;
  salesByCategoryCents: Record<string, number>;
  items: { name: string; quantity: number; netSalesCents: number }[];
}

export function paymentCounts(payment: ToastPayment): boolean {
  return !VOID_PAYMENT_STATUSES.has((payment.paymentStatus ?? '').toUpperCase()) && !payment.voidInfo;
}

export function orderFacts(order: ToastOrder, ref: Reference): OrderFacts | undefined {
  if (order.voided || order.deleted) return undefined;
  const facts: OrderFacts = {
    businessDate: order.businessDate ? isoFromBusinessDate(order.businessDate) : 'unknown',
    serverGuid: order.server?.guid,
    revenueCenter: (order.revenueCenter && ref.revenueCenters.get(order.revenueCenter.guid)) || UNASSIGNED,
    guests: order.numberOfGuests ?? 0,
    checks: 0,
    grossSalesCents: 0,
    netSalesCents: 0,
    taxCents: 0,
    tipsCents: 0,
    gratuityCents: 0,
    salesByCategoryCents: {},
    items: [],
  };
  for (const check of order.checks ?? []) {
    if (check.voided || check.deleted) continue;
    facts.checks += 1;
    facts.taxCents += cents(check.taxAmount);
    for (const selection of check.selections ?? []) {
      if (selection.voided) continue;
      const net = cents(selection.price);
      facts.netSalesCents += net;
      facts.grossSalesCents += cents(selection.preDiscountPrice ?? selection.price);
      const category = (selection.salesCategory && ref.salesCategories.get(selection.salesCategory.guid)) || 'Uncategorized';
      facts.salesByCategoryCents[category] = (facts.salesByCategoryCents[category] ?? 0) + net;
      facts.items.push({ name: selection.displayName ?? 'Unnamed item', quantity: selection.quantity ?? 1, netSalesCents: net });
    }
    for (const payment of check.payments ?? []) {
      if (paymentCounts(payment)) facts.tipsCents += cents(payment.tipAmount);
    }
    for (const charge of check.appliedServiceCharges ?? []) {
      if (charge.gratuity) facts.gratuityCents += cents(charge.chargeAmount);
    }
  }
  return facts.checks > 0 ? facts : undefined;
}

export function allOrderFacts(days: DayData[], ref: Reference): OrderFacts[] {
  return days.flatMap((day) =>
    day.orders.flatMap((order) => {
      const facts = orderFacts(order, ref);
      if (facts && facts.businessDate === 'unknown') facts.businessDate = isoFromBusinessDate(day.businessDate);
      return facts ? [facts] : [];
    }),
  );
}

export function staffName(ref: Reference, guid: string | undefined): string {
  if (!guid) return UNASSIGNED;
  return ref.employees.get(guid)?.name ?? `Unknown employee (${guid.slice(0, 8)})`;
}

export function jobTitle(ref: Reference, entry: ToastTimeEntry): string {
  const guid = entry.jobReference?.guid;
  return (guid && ref.jobs.get(guid)?.title) || 'No job';
}

export const entryHours = (entry: ToastTimeEntry) => (entry.regularHours ?? 0) + (entry.overtimeHours ?? 0);

/** Card tips + declared cash tips + gratuity service charges on one time entry. */
export function entryTipsCents(entry: ToastTimeEntry): number {
  return (
    cents(entry.nonCashTips) +
    cents(entry.declaredCashTips) +
    cents(entry.cashGratuityServiceCharges) +
    cents(entry.nonCashGratuityServiceCharges)
  );
}

export const liveEntries = (day: DayData) => day.timeEntries.filter((entry) => !entry.deleted);

/** Employees still clocked in (no clock-out) on the given days — their hours and tips are incomplete. */
export function openShifts(days: DayData[], ref: Reference): string[] {
  return days.flatMap((day) =>
    liveEntries(day)
      .filter((entry) => entry.inDate && !entry.outDate)
      .map((entry) => `${staffName(ref, entry.employeeReference?.guid)} (${jobTitle(ref, entry)}, ${isoFromBusinessDate(day.businessDate)})`),
  );
}
