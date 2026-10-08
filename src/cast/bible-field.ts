import { z } from 'zod';

/** `''` / whitespace clears a nullable bible field; otherwise trimmed text. */
const bibleField = z
  .string()
  .max(2000)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

/** Lowercase, underscore-joined identity token derived from a display name. */
export function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The tag a scene carries for a bible entry: its consistency tag, or its name
 * as a slug. Scene-split stamps it; the scene location picker writes it.
 */
export function canonicalBibleTag(entry: {
  name: string;
  consistencyTag: string | null;
}): string {
  return entry.consistencyTag || slugifyTag(entry.name);
}

/**
 * Script-style identity for a manually added character/location
 * (`char_maya`, `loc_office`). Sequential `char_001` is the LLM's job;
 * a hand-added row should read as a shortened name, not a ULID.
 */
export function identityToken(kind: 'char' | 'loc', name: string): string {
  const slug = slugifyTag(name);
  const fallback = kind === 'char' ? 'character' : 'location';
  return `${kind}_${slug || fallback}`;
}

/** First free `base`, then `base_2`, `base_3`, … among `taken`. */
export function nextIdentityToken(
  base: string,
  taken: ReadonlySet<string>
): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** The user-editable character bible fields (#1108); casting stays on recast. */
export const characterBibleFieldsSchema = z.object({
  age: bibleField.optional(),
  gender: bibleField.optional(),
  ethnicity: bibleField.optional(),
  physicalDescription: bibleField.optional(),
  standardClothing: bibleField.optional().meta({
    description:
      'Deprecated: the default look’s clothing. Edit the look instead.',
  }),
  // Not a bible field any more (#2065): `cast-edit` folds it into the
  // default look's styling.
  distinguishingFeatures: bibleField.optional().meta({
    description:
      'Deprecated: appended to the default look’s styling unless already there; blank is ignored. Edit the look’s styling instead.',
  }),
  personality: bibleField.optional(),
  movement: bibleField.optional(),
  voiceDescription: bibleField.optional(),
  consistencyTag: bibleField.optional(),
  isPerson: z.boolean().optional(),
});

/** The user-editable location bible fields (#1108); the library link stays on recast. */
export const locationBibleFieldsSchema = z.object({
  type: z.enum(['interior', 'exterior', 'both']).optional(),
  description: bibleField.optional(),
  architecturalStyle: bibleField.optional(),
  keyFeatures: bibleField.optional(),
  ambiance: bibleField.optional(),
  consistencyTag: bibleField.optional(),
});
