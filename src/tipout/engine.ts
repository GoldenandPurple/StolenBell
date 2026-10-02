import type { TipRule } from './rules.js';

/** One employee's day, in cents. Built from Toast time entries and orders. */
export interface StaffDay {
  employeeGuid: string;
  name: string;
  roles: { job: string; hours: number }[];
  netSalesCents: number;
  salesByCategoryCents: Record<string, number>;
  tipsCents: number;
}

export interface Transfer {
  rule: string;
  employeeGuid: string;
  name: string;
  amountCents: number;
}

export interface RuleResult {
  rule: string;
  potCents: number;
  contributions: Transfer[];
  distributions: Transfer[];
  skippedReason?: string;
}

export interface EmployeeTipOut {
  employeeGuid: string;
  name: string;
  jobs: string[];
  hours: number;
  netSalesCents: number;
  tipsEarnedCents: number;
  paidOutCents: number;
  receivedCents: number;
  finalTipsCents: number;
  paidOut: { rule: string; amountCents: number }[];
  received: { rule: string; amountCents: number }[];
}

export interface TipOutResult {
  employees: EmployeeTipOut[];
  rules: RuleResult[];
  warnings: string[];
}

const normalize = (job: string) => job.trim().toLowerCase();

function hoursIn(staff: StaffDay, jobs: Set<string>): number {
  return staff.roles
    .filter((role) => jobs.has(normalize(role.job)))
    .reduce((sum, role) => sum + role.hours, 0);
}

function worksAny(staff: StaffDay, jobs: Set<string>): boolean {
  return staff.roles.some((role) => jobs.has(normalize(role.job)));
}

function recipientWeight(staff: StaffDay, rule: TipRule, toJobs: Set<string>): number {
  const points = new Map(Object.entries(rule.points ?? {}).map(([job, value]) => [normalize(job), value]));
  const roles = staff.roles.filter((role) => toJobs.has(normalize(role.job)));
  if (rule.split === 'equal') {
    return roles.length === 0 ? 0 : Math.max(...roles.map((role) => points.get(normalize(role.job)) ?? 1));
  }
  return roles.reduce((sum, role) => sum + role.hours * (points.get(normalize(role.job)) ?? 1), 0);
}

/**
 * Splits `totalCents` in proportion to `weights` using the largest-remainder
 * method, so the parts are whole cents that always sum to the total.
 * Ties go to the earlier index; callers sort inputs for determinism.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalCents === 0 || weightSum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (totalCents * weight) / weightSum);
  const parts = exact.map(Math.floor);
  let remainder = totalCents - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    parts[index]! += 1;
    remainder -= 1;
  }
  return parts;
}

function basisCents(staff: StaffDay, rule: TipRule, balance: number): number {
  switch (rule.basis) {
    case 'tips':
      return staff.tipsCents;
    case 'remaining_tips':
      return Math.max(0, balance);
    case 'sales': {
      if (!rule.salesCategories) return staff.netSalesCents;
      const wanted = new Set(rule.salesCategories.map(normalize));
      return Object.entries(staff.salesByCategoryCents)
        .filter(([category]) => wanted.has(normalize(category)))
        .reduce((sum, [, cents]) => sum + cents, 0);
    }
  }
}

/** Applies the tip-out rules, in order, to one business day of staff. */
export function calculateTipOut(staffDays: StaffDay[], rules: TipRule[]): TipOutResult {
  const staff = [...staffDays].sort(
    (a, b) => a.name.localeCompare(b.name) || a.employeeGuid.localeCompare(b.employeeGuid),
  );
  const balance = new Map(staff.map((member) => [member.employeeGuid, member.tipsCents]));
  const ruleResults: RuleResult[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    const fromJobs = new Set(rule.from.map(normalize));
    const toJobs = new Set(rule.to.map(normalize));
    const contributors = staff.filter((member) => worksAny(member, fromJobs));
    const recipients = staff
      .map((member) => ({ member, weight: recipientWeight(member, rule, toJobs) }))
      .filter(({ weight }) => weight > 0);

    if (recipients.length === 0) {
      ruleResults.push({
        rule: rule.name,
        potCents: 0,
        contributions: [],
        distributions: [],
        skippedReason: contributors.length
          ? `No one worked as ${rule.to.join('/')}, so nothing was collected`
          : `No one worked as ${rule.from.join('/')}`,
      });
      continue;
    }

    const contributions: Transfer[] = [];
    for (const member of contributors) {
      const held = balance.get(member.employeeGuid)!;
      let amount = Math.round((basisCents(member, rule, held) * rule.percent) / 100);
      if (rule.capAtTips) amount = Math.min(amount, Math.max(0, held));
      if (amount <= 0) continue;
      balance.set(member.employeeGuid, held - amount);
      contributions.push({ rule: rule.name, employeeGuid: member.employeeGuid, name: member.name, amountCents: amount });
    }

    const potCents = contributions.reduce((sum, transfer) => sum + transfer.amountCents, 0);
    const shares = allocate(potCents, recipients.map(({ weight }) => weight));
    const distributions: Transfer[] = recipients
      .map(({ member }, index) => ({
        rule: rule.name,
        employeeGuid: member.employeeGuid,
        name: member.name,
        amountCents: shares[index]!,
      }))
      .filter((transfer) => transfer.amountCents > 0);
    for (const transfer of distributions) {
      balance.set(transfer.employeeGuid, balance.get(transfer.employeeGuid)! + transfer.amountCents);
    }
    ruleResults.push({ rule: rule.name, potCents, contributions, distributions });
  }

  const employees = staff.map((member): EmployeeTipOut => {
    const paidOut = ruleResults.flatMap((result) =>
      result.contributions
        .filter((transfer) => transfer.employeeGuid === member.employeeGuid)
        .map(({ rule, amountCents }) => ({ rule, amountCents })),
    );
    const received = ruleResults.flatMap((result) =>
      result.distributions
        .filter((transfer) => transfer.employeeGuid === member.employeeGuid)
        .map(({ rule, amountCents }) => ({ rule, amountCents })),
    );
    const finalTipsCents = balance.get(member.employeeGuid)!;
    if (finalTipsCents < 0) {
      warnings.push(
        `${member.name} tipped out more than they earned (${formatCents(finalTipsCents)}). Consider capAtTips on sales-based rules.`,
      );
    }
    return {
      employeeGuid: member.employeeGuid,
      name: member.name,
      jobs: [...new Set(member.roles.map((role) => role.job))],
      hours: round2(member.roles.reduce((sum, role) => sum + role.hours, 0)),
      netSalesCents: member.netSalesCents,
      tipsEarnedCents: member.tipsCents,
      paidOutCents: paidOut.reduce((sum, item) => sum + item.amountCents, 0),
      receivedCents: received.reduce((sum, item) => sum + item.amountCents, 0),
      finalTipsCents,
      paidOut,
      received,
    };
  });

  return { employees, rules: ruleResults, warnings };
}

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const formatCents = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
