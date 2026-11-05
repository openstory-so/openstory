/**
 * Near-duplicate cast names (#2249). Pure and client-safe.
 *
 * Exact case and whitespace stay `sameName` in `voice.ts`. One edit is a
 * silent bind when exactly one live name is a single substitution or a
 * single extra letter, and both names have five or more letters. A shared
 * first name with no surname is only a suggestion.
 */

/** Honorifics that name nobody. Kept in step with `STOP_TOKENS` in `voice.ts`. */
const STOP_TOKENS = new Set([
  'the',
  'an',
  'of',
  'mr',
  'mrs',
  'ms',
  'dr',
  'miss',
  'sir',
  'st',
]);

/** NFKC, lower case, trimmed, internal whitespace collapsed to one space. */
export function normalizeCastName(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function letterCount(normalized: string): number {
  let count = 0;
  for (const char of normalized) {
    if (/[\p{L}\p{N}]/u.test(char)) count++;
  }
  return count;
}

/** Distance is exactly one. Equal strings are not one edit apart. */
function distanceIsOne(left: string, right: string): boolean {
  const a = [...left];
  const b = [...right];
  const gap = a.length - b.length;
  if (gap === 0) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diffs > 1) return false;
    }
    return diffs === 1;
  }
  if (gap !== 1 && gap !== -1) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skips = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else if (++skips > 1) {
      return false;
    } else {
      j++;
    }
  }
  return true;
}

/**
 * True when both normalized names have 5+ letters or digits and differ by
 * exactly one substitution or one inserted letter.
 */
export function oneEditApart(a: string, b: string): boolean {
  const left = normalizeCastName(a);
  const right = normalizeCastName(b);
  if (left === right || left === '' || right === '') return false;
  if (letterCount(left) < 5 || letterCount(right) < 5) return false;
  return distanceIsOne(left, right);
}

/** The single candidate one edit from `name`, or null when none or several. */
export function uniqueOneEdit<T extends { name: string }>(
  name: string,
  candidates: readonly T[]
): T | null {
  const hits = candidates.filter((candidate) =>
    oneEditApart(name, candidate.name)
  );
  const only = hits[0];
  return hits.length === 1 && only !== undefined ? only : null;
}

function significantTokens(name: string): string[] {
  return normalizeCastName(name)
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));
}

/**
 * `name` is a single given name that is the first significant token of
 * exactly one candidate, and that candidate is not an exact or one-edit match.
 */
export function uniqueFirstName<T extends { name: string }>(
  name: string,
  candidates: readonly T[]
): T | null {
  const tokens = significantTokens(name);
  const given = tokens.length === 1 ? tokens[0] : undefined;
  if (!given) return null;
  const hits = candidates.filter((candidate) => {
    if (normalizeCastName(candidate.name) === normalizeCastName(name)) {
      return false;
    }
    if (oneEditApart(name, candidate.name)) return false;
    return significantTokens(candidate.name)[0] === given;
  });
  const only = hits[0];
  return hits.length === 1 && only !== undefined ? only : null;
}

export type CastNearMatch<T> = {
  kind: 'one-edit' | 'first-name';
  match: T;
};

/**
 * The cast member to suggest for `name`. One unique one-edit candidate wins.
 * Two one-edit candidates suggest nobody. A unique first name is the looser ask.
 */
export function castNearMatch<T extends { name: string }>(
  name: string,
  others: readonly T[]
): CastNearMatch<T> | null {
  const edits = others.filter((candidate) =>
    oneEditApart(name, candidate.name)
  );
  if (edits.length > 1) return null;
  if (edits[0]) return { kind: 'one-edit', match: edits[0] };
  const first = uniqueFirstName(name, others);
  return first ? { kind: 'first-name', match: first } : null;
}
