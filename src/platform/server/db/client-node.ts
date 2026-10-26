/**
 * Drizzle Database Client — Node / unit-test context.
 *
 * Activated by the `default` import condition in package.json's `imports.#db-client`
 * (i.e. anything that isn't Workerd or Storybook: plain Node, Vitest).
 *
 * The app only touches the database inside Workerd, where `#db-client` resolves
 * to `client-d1.ts` (Cloudflare D1). This module exists so that:
 *   - `Database` (`ReturnType<typeof getDb>`) is the same D1 driver type, which
 *     is also what unit tests get from `createTestDb` (`src/platform/server/db/test-d1.ts`).
 *   - any Node code that reaches `getDb()` without injecting its own instance
 *     fails loudly instead of silently connecting somewhere unexpected.
 */

import { drizzle } from 'drizzle-orm/d1';
import { relations } from '@/platform/server/db/schema/relations';

type Database = ReturnType<typeof buildDb>;

// Never executed — only its return type defines `Database`.
function buildDb(d1: D1Database) {
  return drizzle(d1, { relations });
}

export const getDb = (): Database => {
  throw new Error(
    '[db-node] getDb() is only available in the Workerd runtime (Cloudflare D1). Node and test code must inject a database instance.'
  );
};
