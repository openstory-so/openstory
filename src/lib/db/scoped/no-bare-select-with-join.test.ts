/**
 * Repo guard: no bare `db.select()` in a chain that joins.
 *
 * D1 rejects any query whose RESULT SET exceeds 100 columns ("too many columns
 * in result set"). A bare `.select()` projects every column of every joined
 * table, so a wide join drifts toward that ceiling as unrelated PRs add
 * columns — and nothing local ever complains, because libSQL (what these tests
 * run on) returns a 104-column row happily. #1135 shipped exactly that way and
 * broke every shot read in production.
 *
 * An explicit projection makes the width a decision instead of a side effect,
 * and it also caps what a caller's own join can add.
 */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const JOIN = /\.(left|inner|right|full)Join\(/i;
const BARE_SELECT = /\.select\(\s*\)/g;

/**
 * Find bare selects whose OWN method chain contains a join.
 *
 * Scoping to the chain is the whole difficulty: sibling queries share a
 * statement whenever they sit in one `Promise.all([...])`, so splitting the
 * source on `;` reports a bare single-table select next to an unrelated
 * explicitly-projected join. Walking bracket depth from the `.select()` and
 * stopping at the first depth-0 `,`/`;` — or at the bracket that closes the
 * expression containing it — ends the span exactly where the chain does.
 */
export function findBareSelectWithJoin(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const found: string[] = [];
  for (const match of code.matchAll(BARE_SELECT)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0;
    let end = code.length;
    for (let i = start; i < code.length; i++) {
      const char = code[i];
      if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') {
        // A closer we never opened ends the expression holding this chain.
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if ((char === ',' || char === ';') && depth === 0) {
        end = i;
        break;
      }
    }
    const chain = code.slice(start, end);
    if (JOIN.test(chain)) found.push(chain.trim().slice(0, 120));
  }
  return found;
}

describe('findBareSelectWithJoin', () => {
  it('flags a bare select that joins', () => {
    expect(
      findBareSelectWithJoin('db.select().from(a).leftJoin(b, eq(b.id, a.b));')
    ).toHaveLength(1);
  });

  it('ignores an explicit projection that joins', () => {
    expect(
      findBareSelectWithJoin(
        'db.select({ id: a.id }).from(a).leftJoin(b, eq(b.id, a.b));'
      )
    ).toEqual([]);
  });

  it('ignores a bare select whose sibling in the same statement joins', () => {
    // The shape that defeats splitting on `;` — one statement, two queries.
    expect(
      findBareSelectWithJoin(
        `await Promise.all([
           db.select().from(a).where(eq(a.id, x)),
           db.select({ id: b.id }).from(b).innerJoin(c, eq(c.id, b.c)),
         ]);`
      )
    ).toEqual([]);
  });
});

it('no bare select joins anywhere in src', () => {
  const offenders = globSync('src/**/*.ts')
    .filter((file) => !file.includes('.test.'))
    .flatMap((file) =>
      findBareSelectWithJoin(readFileSync(file, 'utf8')).map(
        (chain) => `${file}: ${chain}`
      )
    );
  expect(offenders).toEqual([]);
});
