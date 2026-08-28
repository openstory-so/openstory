/**
 * Database Seed Script
 * Seeds the database with initial template styles and system team.
 *
 * The actual sync lives in src/lib/db/seed-system-templates.ts and is shared
 * with the worker runtime (src/server.ts), which self-seeds on first request
 * when the stored seed hash is stale. This CLI exists for local/test setup
 * and as a manual escape hatch for remote databases.
 *
 * Usage:
 *   bun db:seed:local                  # Wrangler local D1 (dev env)
 *   bun scripts/seed.ts --test         # Wrangler local D1 (test env, isolated state)
 *   bun scripts/seed.ts --d1           # Cloudflare D1 via HTTP API (manual remote)
 *   bun scripts/seed.ts --d1 --force   # bypass the seed-hash gate (restore lost
 *                                      # template rows when the hash row survived)
 */

import { createD1HttpClient } from '@/lib/db/client-d1-http';
import { ensureLocalModelPricingSeeded } from '@/lib/db/seed-model-pricing';
import {
  ensureSystemTemplatesSeeded,
  type SeedDb,
} from '@/lib/db/seed-system-templates';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { getLocalPlatformProxy } from './local-platform-proxy';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    local: args.includes('--local'),
    test: args.includes('--test'),
    d1: args.includes('--d1'),
    force: args.includes('--force'),
  };
}

async function seed() {
  const { local, test, d1, force } = parseArgs();

  let platformProxy:
    | Awaited<ReturnType<typeof getLocalPlatformProxy<{ DB?: D1Database }>>>
    | undefined;
  let db: SeedDb;

  if (d1) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !databaseId || !token) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required for --d1'
      );
    }
    console.log('🗄️  Using Cloudflare D1 via HTTP API\n');
    db = createD1HttpClient({
      accountId,
      databaseId,
      token,
    });
  } else if (test || local) {
    // getLocalPlatformProxy spins up Miniflare against the bindings defined in
    // wrangler.jsonc (test → [env.test] block) and hands back live D1/R2
    // bindings backed by the same SQLite files that `wrangler dev --env=test`
    // uses. Same code path as production via drizzle-orm/d1.
    const environment = test ? 'test' : undefined;
    console.log(
      `🗄️  Using Wrangler local D1 (${environment ?? 'default'} env)\n`
    );
    platformProxy = await getLocalPlatformProxy<{ DB?: D1Database }>({
      environment,
    });
    const d1Binding = platformProxy.env.DB;
    if (!d1Binding) {
      throw new Error(
        `[seed] D1 binding 'DB' missing from wrangler.jsonc ${environment ? `[env.${environment}]` : ''} — cannot seed.`
      );
    }
    db = drizzleD1(d1Binding);
  } else {
    throw new Error(
      'No database target specified. Use --local, --test, or --d1.'
    );
  }

  try {
    console.log(`🌱 Seeding database...${force ? ' (forced)' : ''}\n`);
    await ensureSystemTemplatesSeeded(db, console.log, { force });
    // Pricing is cron-only in production. Local + Playwright never fire
    // `scheduled()`, so fill `model_pricing` here — insert-if-missing, never
    // overwrite a live `refresh-fal-pricing` snapshot. Skip `--d1`.
    if (!d1) {
      await ensureLocalModelPricingSeeded(db, console.log);
    }
    console.log('🎉 Database seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  } finally {
    await platformProxy?.dispose();
  }
}

await seed();
