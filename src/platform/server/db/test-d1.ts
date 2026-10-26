/**
 * A D1 for unit tests: in-process SQLite (`node:sqlite`) behind the D1 API, so
 * tests use the app's driver (`drizzle-orm/d1`) and get D1's answers:
 *
 *   - results are `{ results, success, meta }`, with no `rowsAffected`;
 *   - more than 100 bound variables in one query is an error;
 *   - foreign keys are always on (`PRAGMA foreign_keys` is ignored);
 *   - `BEGIN` / `SAVEPOINT` are refused (use `db.batch`, which is atomic).
 *
 * It matches D1 only where this file copies it. Local D1 in workerd is the
 * same SQLite, but every query to it from Node is a ~6 ms round trip.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Logger } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { relations } from '@/platform/server/db/schema/relations';

const D1_MAX_BOUND_PARAMS = 100;

function toSqlite(value: unknown): SQLInputValue {
  if (value === undefined) {
    throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value");
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- null, number, bigint, string and Uint8Array pass through, as D1 takes them
  return value as SQLInputValue;
}

function refused(sql: string): string | null {
  const head = sql.trimStart().slice(0, 32).toLowerCase();
  if (/^(begin|savepoint|release|rollback|commit)\b/.test(head)) {
    return 'D1_ERROR: To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.';
  }
  return null;
}

class TestD1Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): TestD1Statement {
    return new TestD1Statement(this.sqlite, this.sql, values.map(toSqlite));
  }

  private execute(arrays: boolean) {
    const reason = refused(this.sql);
    if (reason) throw new Error(reason);
    if (this.params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${this.params.length} > ${D1_MAX_BOUND_PARAMS}): SQLITE_ERROR`
      );
    }
    if (/^\s*pragma\s+foreign_keys\b/i.test(this.sql)) {
      return { rows: [], changes: 0, lastRowId: 0 };
    }
    const stmt = this.sqlite.prepare(this.sql);
    stmt.setReturnArrays(arrays);
    if (stmt.columns().length === 0) {
      const { changes, lastInsertRowid } = stmt.run(...this.params);
      return {
        rows: [],
        changes: Number(changes),
        lastRowId: Number(lastInsertRowid),
      };
    }
    const before = this.sqlite.prepare('select total_changes() as n').get();
    const rows = stmt.all(...this.params);
    const after = this.sqlite.prepare('select total_changes() as n').get();
    return {
      // D1 rows are plain objects; node:sqlite's have a null prototype.
      rows: arrays ? rows : rows.map((row) => ({ ...row })),
      changes: Number(after?.n) - Number(before?.n),
      lastRowId: 0,
    };
  }

  private result(arrays = false) {
    const { rows, changes, lastRowId } = this.execute(arrays);
    return {
      results: rows,
      success: true as const,
      meta: {
        duration: 0,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        size_after: 0,
        rows_read: 0,
        rows_written: changes,
      },
    };
  }

  async all() {
    return this.result();
  }

  async run() {
    return this.result();
  }

  async raw() {
    return this.result(true).results;
  }

  async first(column?: string) {
    const row = this.result().results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  /** For `batch`: run inside the caller's transaction. */
  runForBatch() {
    return this.result();
  }
}

class TestD1Database {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(sql: string): TestD1Statement {
    return new TestD1Statement(this.sqlite, sql);
  }

  /** Atomic, like D1: every statement lands or none does. */
  async batch(statements: TestD1Statement[]) {
    this.sqlite.exec('begin');
    try {
      const results = statements.map((s) => s.runForBatch());
      this.sqlite.exec('commit');
      return results;
    } catch (error) {
      this.sqlite.exec('rollback');
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/** A fresh, migrated D1 for one test file. Call `close()` in `afterAll`. */
export async function createTestDb(options: { logger?: Logger } = {}) {
  const sqlite = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- implements the part of D1Database drizzle-orm/d1 calls
  const d1 = new TestD1Database(sqlite) as unknown as D1Database;
  const db = drizzle(d1, { relations, logger: options.logger });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  return {
    db,
    close: async () => {
      sqlite.close();
    },
  };
}
