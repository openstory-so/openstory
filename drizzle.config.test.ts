import { defineConfig } from 'drizzle-kit';

/**
 * E2E Test Drizzle configuration
 * Uses test.db SQLite file for isolated e2e testing
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:test.db',
  },
  verbose: true,
});
