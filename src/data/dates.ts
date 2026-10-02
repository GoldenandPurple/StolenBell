export const MAX_RANGE_DAYS = 31;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date {
  if (!ISO_DATE.test(value)) throw new Error(`Dates must look like YYYY-MM-DD, got "${value}"`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`"${value}" is not a real date`);
  }
  return date;
}

/** Inclusive list of Toast business dates (yyyyMMdd) between two YYYY-MM-DD dates. */
export function businessDates(startDate: string, endDate: string = startDate): string[] {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (end < start) throw new Error('endDate is before startDate');
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`Date ranges are limited to ${MAX_RANGE_DAYS} days (asked for ${days})`);
  }
  return Array.from({ length: days }, (_, offset) =>
    new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10).replaceAll('-', ''),
  );
}

/** yyyyMMdd -> YYYY-MM-DD */
export const isoFromBusinessDate = (date: string | number) => {
  const text = String(date);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
};
