/** Time-zone helpers built on Intl, so no tz database dependency is needed. */

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant (ms) at which the wall clock in `timeZone` reads `hhmm` on `isoDate` (YYYY-MM-DD). */
export function zonedTimeToUtc(isoDate: string, hhmm: string, timeZone: string): number {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset correctly around DST changes.
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

/** HH:MM wall-clock time of `instant` in `timeZone`. */
export function wallClock(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

/** Parses Toast timestamps such as 2026-09-27T18:30:00.000+0000. Returns undefined when absent or unparseable. */
export function parseInstant(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : instant;
}
