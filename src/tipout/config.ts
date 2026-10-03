import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const TIPOUT_ROLES = ['Bartender', 'Server', 'Host', 'Barback', 'Busser', 'Runner', 'Kitchen'] as const;
export type TipoutRole = (typeof TIPOUT_ROLES)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:MM');

export const TipoutConfigSchema = z
  .object({
    periods: z
      .object({ lunchStart: clock.default('11:00'), dinnerStart: clock.default('16:00') })
      .default({ lunchStart: '11:00', dinnerStart: '16:00' }),
    foodCategories: z.array(z.string().min(1)).min(1).default(['Food']),
    // Where each period's card tips and auto-gratuity come from:
    //   time_entries = what Toast credited to each shift (its own allocation), split by time worked if a shift crosses periods;
    //   restaurant_service = from the day's checks, by the Lunch/Dinner service Toast assigned each order;
    //   check_time / check_items = rebuilt from the day's checks, shared by time open / sales rung in each period;
    //   payment = rebuilt from checks, all to the period each payment was made in.
    cardTipSource: z.enum(['time_entries', 'restaurant_service', 'check_time', 'check_items', 'payment']).default('time_entries'),
    roles: z.record(z.string(), z.enum([...TIPOUT_ROLES, 'ignore'])).default({}),
    // What happens to a Toast job that isn't listed under roles: give it a role, ignore it, or stop the run.
    otherJobs: z.enum([...TIPOUT_ROLES, 'ignore', 'stop']).default('stop'),
    timeZone: z.string().optional(),
  })
  .refine((config) => config.periods.lunchStart < config.periods.dinnerStart, {
    message: 'periods.lunchStart must be before periods.dinnerStart',
  });

export type TipoutConfig = z.infer<typeof TipoutConfigSchema>;

export async function loadTipoutConfig(path: string): Promise<TipoutConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Tip-out config not found at ${path}. Copy config/tipout.yaml there or set TIPOUT_CONFIG_PATH.`);
    }
    throw error;
  }
  const result = TipoutConfigSchema.safeParse(parse(raw) ?? {});
  if (!result.success) {
    throw new Error(`Invalid tip-out config in ${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
