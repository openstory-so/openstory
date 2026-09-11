/**
 * Apply the app's Drizzle migrations to a local embedded SQLite database.
 *
 * The local single-tenant server (npx/bunx) uses libSQL (`file:…`), which is
 * the same SQLite dialect as Cloudflare D1 — so the migrations under
 * `drizzle/migrations` (drizzle-kit's `<ts>_<name>/migration.sql` format) apply
 * unchanged, exactly as `scripts/migrate-local-d1.ts` applies them to the
 * Miniflare-backed D1 in Workerd dev.
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ensureDbFileDir } from '@/platform/server/db/local-db-path';

const MIGRATIONS_FOLDER = './drizzle/migrations';

/**
 * Bring the database named by `url` (default `OPENSTORY_DB`) up to the latest
 * schema. Idempotent — already-applied migrations are skipped.
 */
export async function migrateLocalDb(
  url = process.env.OPENSTORY_DB
): Promise<void> {
  if (!url) {
    throw new Error(
      '[migrate-node] no database URL. Set OPENSTORY_DB (e.g. "file:./.openstory/local.db").'
    );
  }
  ensureDbFileDir(url);
  const client = createClient({ url });
  try {
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    client.close();
  }
}
