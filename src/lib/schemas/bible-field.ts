import { z } from 'zod';

/** `''` / whitespace clears a nullable bible field; otherwise trimmed text. */
export const bibleField = z
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
