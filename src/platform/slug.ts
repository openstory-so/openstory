const MAX_LENGTH = 60;

/** A title as a lowercase URL slug; lowercase so it can never pass `isValidId`. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_LENGTH) return slug || 'untitled';
  const cut = slug.slice(0, MAX_LENGTH);
  const lastDash = cut.lastIndexOf('-');
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}

/** `base`, else the first free `base-2`, `base-3`… */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
