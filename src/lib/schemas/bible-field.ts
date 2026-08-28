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
