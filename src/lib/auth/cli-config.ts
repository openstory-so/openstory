/**
 * Better Auth CLI configuration
 * Exports an auth instance for `bun x auth@1.7.1 generate` (the 1.7 CLI
 * package is `auth`, not `@better-auth/cli`). That emits the Drizzle schema
 * for every Better Auth table (core + plugins). Port new/changed tables from
 * the emitted `auth-schema.ts` verbatim into db/schema/auth.ts, then delete
 * it (it is gitignored).
 *
 * Schema generation never touches a database, and the Node `#db-client` throws
 * by design, so a dummy libSQL-typed drizzle instance stands in for D1.
 *
 * Usage: bun auth:generate
 */

import { drizzle } from 'drizzle-orm/libsql';
import { createAuth } from './config';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export default createAuth(drizzle({ client: {} as never }) as never);
