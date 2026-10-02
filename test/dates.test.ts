import { describe, expect, it } from 'vitest';
import { businessDates, isoFromBusinessDate } from '../src/data/dates.js';

describe('businessDates', () => {
  it('lists inclusive dates across a month boundary', () => {
    expect(businessDates('2026-09-29', '2026-10-02')).toEqual(['20260929', '20260930', '20261001', '20261002']);
  });
  it('defaults to a single day', () => {
    expect(businessDates('2026-10-01')).toEqual(['20261001']);
  });
  it('rejects bad input', () => {
    expect(() => businessDates('10/01/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => businessDates('2026-02-30')).toThrow(/not a real date/);
    expect(() => businessDates('2026-10-02', '2026-10-01')).toThrow(/before/);
    expect(() => businessDates('2026-01-01', '2026-03-01')).toThrow(/limited to 31 days/);
  });
  it('formats business dates back to ISO', () => {
    expect(isoFromBusinessDate(20261001)).toBe('2026-10-01');
  });
});
