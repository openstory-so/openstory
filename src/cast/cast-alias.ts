import type { CastScriptAlias } from '@/platform/server/db/schema';
import { z } from 'zod';

const castAliasSchema = z.array(
  z.object({
    characterId: z.string(),
    name: z.string(),
    consistencyTag: z.string().nullable(),
  })
);

/** Aliases stored on a cast link. Null, and anything that is not the shape, are none. */
export function parseCastAliases(value: unknown): CastScriptAlias[] {
  const parsed = castAliasSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}
