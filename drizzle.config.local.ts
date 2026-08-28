import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Studio against the local Miniflare-backed D1.
 *
 * `bun dev` (and `wrangler dev`) stash the local D1 SQLite under
 * `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<id>.sqlite`, where `<id>`
 * is derived from the D1 binding's `database_id` via Miniflare's DO-namespace
 * hash. We mirror that derivation so Studio opens the exact file the worker
 * reads/writes — no out-of-band sync.
 *
 * Honors `CLOUDFLARE_ENV=test` (`CLOUDFLARE_ENV=test bun db:studio:local`)
 * to target [env.test]'s D1.
 *
 * Hash source: miniflare's `durableObjectNamespaceIdFromName` with
 * uniqueKey = `miniflare-D1DatabaseObject`.
 */
function miniflareD1FileName(databaseId: string): string {
  const uniqueKey = 'miniflare-D1DatabaseObject';
  const key = createHash('sha256').update(uniqueKey).digest();
  const nameHmac = createHmac('sha256', key)
    .update(databaseId)
    .digest()
    .subarray(0, 16);
  const hmac = createHmac('sha256', key)
    .update(nameHmac)
    .digest()
    .subarray(0, 16);
  return `${Buffer.concat([nameHmac, hmac]).toString('hex')}.sqlite`;
}

/**
 * Minimal JSONC reader: strip comments + trailing commas, then JSON.parse.
 * Avoids pulling jsonc-parser / json5 as a direct dep for a one-off dev script.
 */
function readWranglerConfig(): {
  d1_databases?: Array<{ binding: string; database_id: string }>;
  env?: Record<
    string,
    { d1_databases?: Array<{ binding: string; database_id: string }> }
  >;
} {
  const raw = readFileSync('wrangler.jsonc', 'utf-8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

const env = process.env.CLOUDFLARE_ENV;
const cfg = readWranglerConfig();
const block = env ? cfg.env?.[env] : cfg;
const dbBinding = block?.d1_databases?.find((d) => d.binding === 'DB');
if (!dbBinding) {
  throw new Error(
    `[drizzle.config.local] No D1 'DB' binding in wrangler.jsonc ${env ? `[env.${env}]` : '(default)'}`
  );
}

const sqlitePath = resolve(
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
  miniflareD1FileName(dbBinding.database_id)
);

if (!existsSync(sqlitePath)) {
  throw new Error(
    `[drizzle.config.local] Local D1 sqlite not found at ${sqlitePath}.\n` +
      `Run \`bun db:migrate:local\`${env === 'test' ? ' (or `bun db:migrate:test`)' : ''} first to create it.`
  );
}

export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${sqlitePath}`,
  },
  verbose: true,
});
