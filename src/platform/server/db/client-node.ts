/**
 * Drizzle Database Client — Node / Bun (non-Workerd) context.
 *
 * Activated by the `default` import condition in package.json's `imports.#db-client`
 * (i.e. anything that isn't Workerd or Storybook: plain Node/Bun, Vitest).
 *
 * Two runtimes resolve here:
 *   - **Unit tests / Storybook graphs** inject their own in-memory `@libsql/client`
 *     instance via `drizzle({ client, relations })` and never call `getDb()`.
 *     For them this stays a loud guardrail: a `getDb()` reached without an
 *     injected instance throws rather than silently connecting somewhere.
 *   - **The local single-tenant server / CLI** (the npx/bunx distribution) sets
 *     `OPENSTORY_DB` to a libSQL URL — typically `file:./.openstory/local.db`.
 *     libSQL is embedded SQLite, the same dialect as Cloudflare D1, so the app's
 *     Drizzle schema and every migration in `drizzle/migrations` apply unchanged.
 *
 * The app's production runtime is Workerd, where `#db-client` resolves to
 * `client-d1.ts` (Cloudflare D1) and this module is never bundled — so the
 * Node-only `@libsql/client` driver never enters the Worker bundle.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { ensureDbFileDir } from '@/platform/server/db/local-db-path';
import { relations } from '@/platform/server/db/schema/relations';

type Database = ReturnType<typeof buildDb>;

function buildDb(client: Client) {
  return drizzle({ client, relations });
}

let _db: Database | undefined;

/**
 * Open (once) the embedded SQLite database named by `OPENSTORY_DB`, or throw
 * when it is unset. The absent-env throw is deliberate: unit/story code that
 * reaches `getDb()` without injecting its own instance must fail loudly, which
 * is the behaviour this module has always had for non-Workerd runtimes.
 */
export const getDb = (): Database => {
  if (_db) return _db;

  const url = process.env.OPENSTORY_DB;
  if (!url) {
    throw new Error(
      '[db-node] getDb() has no database. Set OPENSTORY_DB (e.g. "file:./.openstory/local.db") to run the local non-Workerd server, or inject a db instance in tests.'
    );
  }

  ensureDbFileDir(url);
  _db = buildDb(createClient({ url }));
  return _db;
};
