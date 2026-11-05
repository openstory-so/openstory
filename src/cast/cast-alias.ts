import type { CastScriptAlias } from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import { z } from 'zod';

const castAliasSchema = z.array(
  z.object({
    characterId: z.string(),
    name: z.string(),
    consistencyTag: z.string().nullable(),
  })
);

/** Aliases stored on a cast link. Null is none. A present value of the wrong shape throws. */
export function parseCastAliases(value: unknown): CastScriptAlias[] {
  if (value == null) return [];
  const parsed = castAliasSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('Cast aliases are not the stored shape.');
  }
  return parsed.data;
}
