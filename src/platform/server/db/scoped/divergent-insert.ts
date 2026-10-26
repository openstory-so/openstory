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

// D1 reports a constraint failure only in its message (`D1_ERROR: UNIQUE
// constraint failed: …`; a primary-key clash reads the same), and drizzle
// wraps it in a DrizzleQueryError whose own message is the SQL. So walk the
// cause chain and match the text. FK and NOT NULL messages do not say UNIQUE.
const UNIQUE_MESSAGE_RE = /UNIQUE constraint failed/;

export function isUniqueConstraintError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (UNIQUE_MESSAGE_RE.test(e.message)) return true;
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
