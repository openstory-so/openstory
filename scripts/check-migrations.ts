#!/usr/bin/env bun
/**
 * Migration safety check.
 *
 * Flags destructive SQL in drizzle migrations. The standard SQLite
 * "table rebuild" pattern (DROP X -> INSERT SELECT -> RENAME __new_X) is
 * structurally unsafe on Cloudflare D1 because its HTTP /query endpoint
 * wraps multi-statement bodies in an implicit transaction,
 * inside which `PRAGMA foreign_keys=OFF` is silently ignored — so any
 * inbound `ON DELETE CASCADE` fires when the parent table is dropped.
 *
 * See GitHub issue #612 for the verified mechanism and the production
 * incident on 2026-04-29.
 *
 * It ALSO flags expensive data-backfill UPDATEs — a correlated/per-row
 * subquery (a scalar subquery in SET, or a WHERE EXISTS/IN subquery) runs once
 * per row of the target table, and over a large table (especially filtering on
 * an unindexed column) trips D1's remote CPU-time limit (error 7429). That
 * rolls the whole migration back and, because `wrangler d1 migrations apply`
 * runs before `wrangler deploy`, freezes the deploy pipeline. Local/CI never
 * catch it: Miniflare D1 has no CPU governor and seed data is tiny. Rewrite as
 * a set-based `UPDATE … FROM (<join>)` (issue #1019); those are NOT flagged.
 *
 * Modes:
 *   bun scripts/check-migrations.ts file1.sql file2.sql ...
 *     Scan the given files (used by lefthook with {staged_files}).
 *
 *   bun scripts/check-migrations.ts
 *     Scan all migrations not yet recorded in the local journal.
 *
 *   bun scripts/check-migrations.ts --all
 *     Scan every migration on disk.
 *
 *   bun scripts/check-migrations.ts --allow-destructive
 *     Bypass the destructive-operation findings (escape hatch for local dev).
 *
 *   bun scripts/check-migrations.ts --allow-expensive
 *     Bypass the expensive-backfill findings.
 *
 * Exit codes:
 *   0 — no findings (or all findings bypassed)
 *   1 — findings found and not bypassed
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, isAbsolute, join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'drizzle/migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta/_journal.json');
const SCHEMA_DIR = join(REPO_ROOT, 'src/platform/server/db/schema');

type DestructiveOperation = {
  file: string;
  line: number;
  operation: string;
  statement: string;
  table: string;
  cascadeChildCount: number;
};

type Journal = {
  entries: Array<{ idx: number; tag: string }>;
};

const DESTRUCTIVE_PATTERNS = [
  {
    pattern: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?([^`\s;]+)`?/gi,
    name: 'DROP TABLE',
  },
  {
    pattern: /TRUNCATE\s+(?:TABLE\s+)?`?([^`\s;]+)`?/gi,
    name: 'TRUNCATE',
  },
  {
    pattern: /DELETE\s+FROM\s+`?([^`\s;]+)`?\s*(?:;|$)/gi,
    name: 'DELETE ALL',
  },
  {
    pattern: /ALTER\s+TABLE\s+`?([^`\s;]+)`?\s+DROP\s+COLUMN/gi,
    name: 'DROP COLUMN',
  },
] as const;

// Per-row subquery patterns inside an UPDATE — the #1019 failure class. Each
// runs the subquery once per outer row, so on a large table it does O(rows^2)
// work and trips D1's remote CPU-time limit. A set-based `UPDATE … FROM
// (<join>)` has its SELECT in the FROM clause (evaluated once) with a plain
// column reference in SET and no EXISTS/IN in WHERE, so none of these match it.
const EXPENSIVE_UPDATE_PATTERNS = [
  {
    // Scalar subquery in SET (or a `col = (SELECT …)` predicate).
    pattern: /=\s*\(\s*SELECT\b/gi,
    name: 'per-row scalar subquery',
  },
  {
    // Correlated existence test in WHERE.
    pattern: /\b(?:NOT\s+)?EXISTS\s*\(\s*SELECT\b/gi,
    name: 'correlated EXISTS subquery',
  },
  {
    // Membership test against a subquery in WHERE.
    pattern: /\bIN\s*\(\s*SELECT\b/gi,
    name: 'subquery in IN (…)',
  },
] as const;

type ExpensiveFinding = {
  file: string;
  line: number;
  kind: string;
  statement: string;
};

function getAppliedMigrations(): Set<string> {
  if (!existsSync(JOURNAL_PATH)) return new Set();
  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));
  return new Set(journal.entries.map((e) => `${e.tag}.sql`));
}

/**
 * Build a map of parent table -> number of inbound CASCADE FKs by scanning
 * the Drizzle schema. Used to annotate DROP TABLE findings with the
 * blast-radius count. Best-effort regex parser: an unusual definition style
 * just won't contribute, which only loses precision — every DROP TABLE is
 * still flagged.
 */
function buildCascadeMap(): Map<string, number> {
  const cascadesByParent = new Map<string, number>();
  if (!existsSync(SCHEMA_DIR)) return cascadesByParent;

  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts'));
  const varToTable = new Map<string, string>();

  for (const f of files) {
    const content = readFileSync(join(SCHEMA_DIR, f), 'utf-8');
    // Tables are declared via `snakeCase.table('name', …)` (the project's
    // snake_case column-casing wrapper); older ones via `sqliteTable('name', …)`.
    const re =
      /export\s+const\s+(\w+)\s*=\s*(?:sqliteTable|\w+\.table)\s*\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const varName = m[1];
      const tableName = m[2];
      if (!varName || !tableName) continue;
      varToTable.set(varName, tableName);
    }
  }

  for (const f of files) {
    const content = readFileSync(join(SCHEMA_DIR, f), 'utf-8');
    const re =
      /references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.\w+\s*,\s*\{[^}]*onDelete\s*:\s*['"]cascade['"]/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const varName = m[1];
      if (!varName) continue;
      const parentTable = varToTable.get(varName);
      if (!parentTable) continue;
      cascadesByParent.set(
        parentTable,
        (cascadesByParent.get(parentTable) ?? 0) + 1
      );
    }
  }

  return cascadesByParent;
}

function findDestructiveOperations(
  filePath: string,
  cascadesByParent: Map<string, number>
): DestructiveOperation[] {
  const content = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);
  const lines = content.split('\n');
  const operations: DestructiveOperation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const { pattern, name } of DESTRUCTIVE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const rawTable = match[1];
        if (!rawTable) continue;
        const table = rawTable.replace(/[`"[\]]/g, '');
        // __new_X are intra-migration scratch tables, not real concerns.
        if (table.startsWith('__new_')) continue;
        operations.push({
          file: fileName,
          line: i + 1,
          operation: name,
          statement: line.trim().slice(0, 120),
          table,
          cascadeChildCount: cascadesByParent.get(table) ?? 0,
        });
      }
    }
  }

  return operations;
}

/**
 * Flag UPDATE statements that run a subquery per outer row (#1019). Blanks out
 * SQL comments first — a migration's own header often explains the anti-pattern
 * it deliberately avoids ("NOT a `= (SELECT …)`") and must not self-trigger —
 * while preserving newlines so reported line numbers still point at real SQL.
 */
export function findExpensiveBackfills(filePath: string): ExpensiveFinding[] {
  const raw = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);
  const cleaned = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');

  const findings: ExpensiveFinding[] = [];
  // Each UPDATE … up to its terminating `;` (subqueries don't contain `;`).
  const updateStatement = /\bUPDATE\b[\s\S]*?;/gi;
  let stmt: RegExpExecArray | null;
  while ((stmt = updateStatement.exec(cleaned)) !== null) {
    const text = stmt[0];
    const line = cleaned.slice(0, stmt.index).split('\n').length;
    for (const { pattern, name } of EXPENSIVE_UPDATE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        findings.push({
          file: fileName,
          line,
          kind: name,
          statement: text.replace(/\s+/g, ' ').trim().slice(0, 140),
        });
      }
    }
  }
  return findings;
}

function listSqlFiles(all: boolean): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const top = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const fromDirs: string[] = [];
  for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inner = join(MIGRATIONS_DIR, entry.name, 'migration.sql');
    if (existsSync(inner)) fromDirs.push(`${entry.name}/migration.sql`);
  }
  const all_ = [...top, ...fromDirs];
  if (all) return all_.map((f) => join(MIGRATIONS_DIR, f));
  const applied = getAppliedMigrations();
  if (applied.size === 0) return all_.map((f) => join(MIGRATIONS_DIR, f));
  return all_
    .filter((f) => !applied.has(f) && !applied.has(f.split('/').pop() ?? f))
    .map((f) => join(MIGRATIONS_DIR, f));
}

function main(): void {
  const args = process.argv.slice(2);
  const allowDestructive = args.includes('--allow-destructive');
  const allowExpensive = args.includes('--allow-expensive');
  const checkAll = args.includes('--all');
  const positional = args.filter((a) => !a.startsWith('--'));

  const cascadesByParent = buildCascadeMap();

  const targets =
    positional.length > 0
      ? positional.map((p) => (isAbsolute(p) ? p : join(process.cwd(), p)))
      : listSqlFiles(checkAll);

  const migrationDirOf = (filePath: string): string => {
    const afterMigrations = filePath.split('/drizzle/migrations/')[1];
    const firstSegment = afterMigrations?.split('/')[0];
    return firstSegment ? firstSegment.replace(/\.sql$/, '') : 'unknown';
  };

  const allOps: Array<DestructiveOperation & { migrationDir: string }> = [];
  const expensiveOps: Array<ExpensiveFinding & { migrationDir: string }> = [];
  for (const filePath of targets) {
    if (!existsSync(filePath)) continue;
    const dir = migrationDirOf(filePath);
    for (const op of findDestructiveOperations(filePath, cascadesByParent)) {
      allOps.push({ ...op, migrationDir: dir });
    }
    for (const finding of findExpensiveBackfills(filePath)) {
      expensiveOps.push({ ...finding, migrationDir: dir });
    }
  }

  if (allOps.length === 0 && expensiveOps.length === 0) {
    console.log('No migration issues detected.');
    process.exit(0);
  }

  if (allOps.length > 0) {
    console.log('Destructive operations detected:\n');
    for (const op of allOps) {
      const cascade =
        op.operation === 'DROP TABLE' && op.cascadeChildCount > 0
          ? ` ⚠ ${op.cascadeChildCount} cascade child FK(s)`
          : '';
      console.log(
        `  ${op.migrationDir}/${op.file}:${op.line} — ${op.operation} \`${op.table}\`${cascade}`
      );
      console.log(`    ${op.statement}`);
    }
    console.log('');
    console.log(
      'These are unsafe on D1/Turso HTTP migrators (issue #612). Either:'
    );
    console.log(
      '  1. Refactor the schema change to use ALTER TABLE column ops,'
    );
    console.log(
      '  2. Make it safe for the automatic path and prove it first (never apply'
    );
    console.log(
      '     a migration to production by hand): AGENTS.md, "D1 table-rebuild trap",'
    );
    console.log(
      '  3. Or pass --allow-destructive if data loss is intentional.'
    );
    console.log('');
  }

  if (expensiveOps.length > 0) {
    console.log('Expensive backfill UPDATEs detected:\n');
    for (const op of expensiveOps) {
      console.log(`  ${op.migrationDir}/${op.file}:${op.line} — ${op.kind}`);
      console.log(`    ${op.statement}`);
    }
    console.log('');
    console.log(
      'A per-row subquery over a large table trips D1’s remote CPU-time'
    );
    console.log(
      'limit (7429) and freezes the deploy — migrations apply before deploy'
    );
    console.log('(issue #1019). Either:');
    console.log(
      '  1. Rewrite as a set-based `UPDATE … FROM (<join>)` (verify the plan'
    );
    console.log(
      '     with EXPLAIN QUERY PLAN: scan the driver, search the target by key),'
    );
    console.log(
      '  2. Or pass --allow-expensive if the touched tables are provably small.'
    );
    console.log('');
  }

  const destructiveBlocks = allOps.length > 0 && !allowDestructive;
  const expensiveBlocks = expensiveOps.length > 0 && !allowExpensive;
  if (allowDestructive && allOps.length > 0) {
    console.log('--allow-destructive set; destructive findings bypassed.');
  }
  if (allowExpensive && expensiveOps.length > 0) {
    console.log('--allow-expensive set; expensive findings bypassed.');
  }
  process.exit(destructiveBlocks || expensiveBlocks ? 1 : 0);
}

if (import.meta.main) main();
