/**
 * Better Auth CLI configuration
 * Exports an auth instance for `bun x auth@1.7.2 generate` (the 1.7 CLI
 * package is `auth`, not `@better-auth/cli`). That emits the Drizzle schema
 * for every Better Auth table (core + plugins). Port new/changed tables from
 * the emitted `auth-schema.ts` verbatim into db/schema/auth.ts, then delete
 * it (it is gitignored).
 *
 * Schema generation never touches a database, and the Node `#db-client` throws
 * by design, so a dummy libSQL-typed drizzle instance stands in for D1.
 *
 * The OAuth provider plugin (#1456) seeds its `oauthResource` rows in `init`,
 * which the CLI kicks off but never awaits. Against the dummy db that init
 * rejects (and, before the tables are ported, the adapter can't even find the
 * model). Generation doesn't need it, so the rejection is logged rather than
 * left to crash the process.
 *
 * Usage: bun auth:generate
 */

import { drizzle } from 'drizzle-orm/libsql';
import { createAuth } from './config';

process.on('unhandledRejection', (reason) => {
  // oxlint-disable-next-line no-console -- CLI process, no logger sink
  console.warn(
    '[auth:generate] ignoring rejected background init:',
    reason instanceof Error ? reason.message : reason
  );
});

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export default createAuth(drizzle({ client: {} as never }) as never);
