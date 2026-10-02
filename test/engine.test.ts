import { describe, expect, it } from 'vitest';
import { allocate, calculateTipOut, type StaffDay } from '../src/tipout/engine.js';
import { TipRuleSchema, type TipRule } from '../src/tipout/rules.js';

const rule = (input: Record<string, unknown>): TipRule => TipRuleSchema.parse(input);

const staff = (name: string, roles: [string, number][], tips: number, sales = 0, categories: Record<string, number> = {}): StaffDay => ({
  employeeGuid: name.toLowerCase(),
  name,
  roles: roles.map(([job, hours]) => ({ job, hours })),
  netSalesCents: sales,
  salesByCategoryCents: categories,
  tipsCents: tips,
});

describe('allocate', () => {
  it('always sums to the total in whole cents', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1001, [5.5, 3.25, 7]).reduce((a, b) => a + b)).toBe(1001);
  });
  it('returns zeros when there is nothing to split', () => {
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('calculateTipOut', () => {
  it('takes a percent of sales from servers and splits it by bartender hours', () => {
    const result = calculateTipOut(
      [
        staff('Avery', [['Server', 6]], 20_000, 100_000),
        staff('Jordan', [['Server', 6]], 15_000, 50_000),
        staff('Casey', [['Bartender', 6]], 10_000),
        staff('Drew', [['Bartender', 3]], 5_000),
      ],
      [rule({ name: 'Bar', from: ['server'], to: ['BARTENDER'], basis: 'sales', percent: 2 })],
    );
    const by = Object.fromEntries(result.employees.map((e) => [e.name, e]));
    expect(by.Avery!.paidOutCents).toBe(2_000);
    expect(by.Jordan!.paidOutCents).toBe(1_000);
    expect(by.Casey!.receivedCents).toBe(2_000);
    expect(by.Drew!.receivedCents).toBe(1_000);
    const before = 20_000 + 15_000 + 10_000 + 5_000;
    expect(result.employees.reduce((sum, e) => sum + e.finalTipsCents, 0)).toBe(before);
  });

  it('only counts the listed sales categories', () => {
    const result = calculateTipOut(
      [staff('Avery', [['Server', 5]], 10_000, 80_000, { Food: 50_000, Liquor: 20_000, Wine: 10_000 }), staff('Casey', [['Bartender', 5]], 0)],
      [rule({ name: 'Bar', from: ['Server'], to: ['Bartender'], basis: 'sales', salesCategories: ['liquor', 'Wine'], percent: 10 })],
    );
    expect(result.rules[0]!.potCents).toBe(3_000);
  });

  it('works as a pool when from and to overlap, weighted by hours and points', () => {
    const result = calculateTipOut(
      [staff('A', [['Server', 8]], 30_000), staff('B', [['Server', 4]], 0), staff('C', [['Busser', 4]], 0)],
      [rule({ name: 'Pool', from: ['Server', 'Busser'], to: ['Server', 'Busser'], basis: 'tips', percent: 100, points: { Busser: 0.5 } })],
    );
    const by = Object.fromEntries(result.employees.map((e) => [e.name, e.finalTipsCents]));
    // weights 8, 4, 2 → 30000 * 8/14, 4/14, 2/14
    expect(by).toEqual({ A: 17_143, B: 8_571, C: 4_286 });
  });

  it('uses tips left after earlier rules for remaining_tips', () => {
    const result = calculateTipOut(
      [staff('A', [['Server', 5]], 10_000, 100_000), staff('B', [['Bartender', 5]], 0), staff('K', [['Cook', 5]], 0)],
      [
        rule({ name: 'Bar', from: ['Server'], to: ['Bartender'], basis: 'sales', percent: 4 }),
        rule({ name: 'Kitchen', from: ['Server'], to: ['Cook'], basis: 'remaining_tips', percent: 10 }),
      ],
    );
    expect(result.rules.map((r) => r.potCents)).toEqual([4_000, 600]);
  });

  it('caps contributions at tips held when capAtTips is set, and warns otherwise', () => {
    const people = [staff('A', [['Server', 5]], 1_000, 100_000), staff('B', [['Bartender', 5]], 0)];
    const capped = calculateTipOut(people, [rule({ name: 'Bar', from: ['Server'], to: ['Bartender'], basis: 'sales', percent: 5, capAtTips: true })]);
    expect(capped.rules[0]!.potCents).toBe(1_000);
    expect(capped.warnings).toEqual([]);
    const uncapped = calculateTipOut(people, [rule({ name: 'Bar', from: ['Server'], to: ['Bartender'], basis: 'sales', percent: 5 })]);
    expect(uncapped.rules[0]!.potCents).toBe(5_000);
    expect(uncapped.warnings[0]).toMatch(/A tipped out more than they earned/);
  });

  it('collects nothing when no recipient worked', () => {
    const result = calculateTipOut(
      [staff('A', [['Server', 5]], 10_000, 50_000)],
      [rule({ name: 'Bar', from: ['Server'], to: ['Bartender'], basis: 'sales', percent: 2 })],
    );
    expect(result.rules[0]!.potCents).toBe(0);
    expect(result.rules[0]!.skippedReason).toMatch(/No one worked as Bartender/);
    expect(result.employees[0]!.finalTipsCents).toBe(10_000);
  });

  it('splits equally regardless of hours when split is equal', () => {
    const result = calculateTipOut(
      [staff('A', [['Server', 5]], 10_000), staff('B', [['Host', 1]], 0), staff('C', [['Host', 7]], 0)],
      [rule({ name: 'Host', from: ['Server'], to: ['Host'], basis: 'tips', percent: 10, split: 'equal' })],
    );
    expect(result.rules[0]!.distributions.map((d) => d.amountCents)).toEqual([500, 500]);
  });
});

describe('TipRuleSchema', () => {
  it('rejects salesCategories on a non-sales basis', () => {
    expect(() => rule({ name: 'x', from: ['a'], to: ['b'], basis: 'tips', percent: 1, salesCategories: ['Beer'] })).toThrow();
  });
});
