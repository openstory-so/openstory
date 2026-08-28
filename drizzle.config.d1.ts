import { defineConfig } from 'drizzle-kit';

/**
 * Cloudflare D1 Drizzle configuration
 *
 * Used by:
 *   bun db:generate     # Generate migrations from schema changes (offline)
 *   bun db:studio:d1    # Open Drizzle Studio connected to D1
 *
 * drizzle-kit no longer applies migrations to remote databases — that's
 * `wrangler d1 migrations apply` (see the `deploy` / `db:migrate:prd`
 * package scripts, #897). The dbCredentials below are only needed for
 * db:studio:d1: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID,
 * CLOUDFLARE_API_TOKEN.
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
  },
  verbose: true,
});
