import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const TIPOUT_ROLES = ['Bartender', 'Server', 'Host', 'Barback', 'Busser', 'Kitchen'] as const;
export type TipoutRole = (typeof TIPOUT_ROLES)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:MM');

export const TipoutConfigSchema = z
  .object({
    periods: z
      .object({ lunchStart: clock.default('11:00'), dinnerStart: clock.default('16:00') })
      .default({ lunchStart: '11:00', dinnerStart: '16:00' }),
    foodCategories: z.array(z.string().min(1)).min(1).default(['Food']),
    roles: z.record(z.string(), z.enum([...TIPOUT_ROLES, 'ignore'])).default({}),
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
