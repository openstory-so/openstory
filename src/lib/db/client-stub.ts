/**
 * Drizzle Database Client — Storybook stub.
 *
 * Activated by the `storybook` import condition in package.json's `imports.#db-client`.
 * Storybook never reaches `getDb()` at runtime — `.storybook/server-stub-plugin.ts`
 * replaces every server-only path (`@/functions/*`, `@/functions/session`, etc.) with a
 * chainable Proxy before code that touches the DB ever runs. This file exists so the
 * import resolves to something with zero `@libsql/client` / `drizzle-orm` cost in the
 * Storybook bundle.
 */

import type { getDb as getRealDb } from './client-d1';

type Database = ReturnType<typeof getRealDb>;

const throwStub = (): never => {
  throw new Error(
    '[db-stub] getDb() called in a non-Workerd runtime — Storybook should not reach the DB layer.'
  );
};

// Storybook's serverStubPlugin replaces server-only paths before they reach
// the DB layer, so this should never execute. If it does, the throw surfaces
// a loud error rather than crashing deep in Drizzle internals.
export const getDb = (): Database => throwStub();
