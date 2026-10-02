import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const TipSourcesSchema = z
  .object({
    cardTips: z.boolean().default(true).describe('Non-cash (card) tips from time entries'),
    declaredCashTips: z.boolean().default(true).describe('Cash tips declared at clock-out'),
    gratuities: z.boolean().default(true).describe('Auto-gratuity service charges'),
  })
  .default({ cardTips: true, declaredCashTips: true, gratuities: true });

export const TipRuleSchema = z
  .object({
    name: z.string().min(1),
    from: z.array(z.string().min(1)).min(1).describe('Job titles that pay into this tip-out'),
    to: z.array(z.string().min(1)).min(1).describe('Job titles that share the tip-out'),
    basis: z
      .enum(['sales', 'tips', 'remaining_tips'])
      .describe(
        'sales: percent of the contributor\'s net sales; tips: percent of tips they earned; remaining_tips: percent of what they hold after earlier rules',
      ),
    percent: z.number().min(0).max(100),
    salesCategories: z
      .array(z.string().min(1))
      .optional()
      .describe('With basis "sales", only count sales in these Toast sales categories (e.g. Liquor, Beer, Wine)'),
    split: z
      .enum(['hours', 'equal'])
      .default('hours')
      .describe('hours: share by hours worked in a "to" job; equal: one share per recipient'),
    points: z
      .record(z.string(), z.number().positive())
      .optional()
      .describe('Optional weight per recipient job title, e.g. { "Bartender": 1, "Barback": 0.5 }'),
    capAtTips: z
      .boolean()
      .default(false)
      .describe('Never take more than the contributor currently holds in tips'),
  })
  .refine((rule) => !rule.salesCategories || rule.basis === 'sales', {
    message: 'salesCategories only applies when basis is "sales"',
  });

export const TipRulesFileSchema = z.object({
  tipSources: TipSourcesSchema,
  rules: z.array(TipRuleSchema).default([]),
});

export type TipSources = z.infer<typeof TipSourcesSchema>;
export type TipRule = z.infer<typeof TipRuleSchema>;
export type TipRulesFile = z.infer<typeof TipRulesFileSchema>;

export async function loadTipRules(path: string): Promise<TipRulesFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return TipRulesFileSchema.parse({});
    }
    throw error;
  }
  const result = TipRulesFileSchema.safeParse(parse(raw) ?? {});
  if (!result.success) {
    throw new Error(`Invalid tip rules in ${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
