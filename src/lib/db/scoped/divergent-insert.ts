/**
 * Race-tolerant divergent-insert helper.
 *
 * The `*_sheet_variants` and `shot_variants` tables enforce uniqueness on
 * `(parent, model, inputHash) WHERE diverged_at IS NOT NULL` via a partial
 * unique index. Drizzle's SQLite `onConflictDoNothing` does not emit the
 * partial-index `WHERE` predicate after the target column list, so it cannot
 * be used to absorb conflicts on this index — the conflict raises instead.
 *
 * The pattern below combines two race-tolerance mechanisms:
 *
 *   1. A pre-check `SELECT` for an existing divergent row, returned early if
 *      found. Handles the common case where the engine retries the same workflow
 *      step (same payload, same hash) and the row was inserted on a previous
 *      attempt.
 *
 *   2. A `try/catch` around `INSERT` that re-runs the SELECT on a unique-
 *      constraint violation. Handles cross-run concurrency: two workflows
 *      racing the same divergent path can both pass the pre-check and one
 *      INSERT will lose. Without the retry-fetch the loser would surface as
 *      a workflow failure even though the variant landed successfully.
 */

// Three drivers carry SQLite errors through this codepath:
//   - `@libsql/client` populates `extendedCode` (`SQLITE_CONSTRAINT_UNIQUE`).
//   - `better-sqlite3` populates `code` (`SQLITE_CONSTRAINT_UNIQUE`).
//   - Cloudflare D1 surfaces a plain `Error` (`D1_ERROR: UNIQUE constraint
//     failed: …`) with no `code`/`extendedCode` field.
// Detect via the structured fields when present, then fall back to the
// canonical SQLite message text — D1 included. The structured branch
// returns early ONLY for matches; on a known-but-non-matching code we
// still consult the message regex (cheap, and SQLite's FK / NOT NULL
// messages don't mention "UNIQUE", so we don't over-match).
type SqliteErrorShape = { code?: string; extendedCode?: string };

const UNIQUE_CONSTRAINT_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
]);

const UNIQUE_MESSAGE_RE = /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/;

export function isUniqueConstraintError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const shape = err as SqliteErrorShape;
    if (
      (typeof shape.code === 'string' &&
        UNIQUE_CONSTRAINT_CODES.has(shape.code)) ||
      (typeof shape.extendedCode === 'string' &&
        UNIQUE_CONSTRAINT_CODES.has(shape.extendedCode))
    ) {
      return true;
    }
  }
  if (err instanceof Error) {
    return UNIQUE_MESSAGE_RE.test(err.message);
  }
  return false;
}

/**
 * Run an `INSERT` that may collide with a partial-unique-indexed divergent
 * row. On collision, re-run `findExisting` and return its row. If neither the
 * pre-check nor the post-collision fetch finds the row, the unique-constraint
 * violation propagates — that means the conflict was on a different
 * constraint than the one `findExisting` matches, which is a genuine error.
 */
export async function insertDivergentRaceTolerant<T>({
  findExisting,
  insert,
  errorMessage,
}: {
  findExisting: () => Promise<T[]>;
  insert: () => Promise<T[]>;
  errorMessage: string;
}): Promise<T> {
  const preExisting = await findExisting();
  const preExistingRow = preExisting[0];
  if (preExistingRow) {
    return preExistingRow;
  }

  let inserted: T[];
  try {
    inserted = await insert();
  } catch (err) {
    if (!isUniqueConstraintError(err)) {
      throw err;
    }
    const raced = await findExisting();
    const racedRow = raced[0];
    if (racedRow) {
      return racedRow;
    }
    throw err;
  }

  const row = inserted[0];
  if (!row) {
    throw new Error(errorMessage);
  }
  return row;
}
