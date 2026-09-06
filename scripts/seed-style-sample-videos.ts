/**
 * Seed `styles.sampleVideos` (issue #718).
 *
 * One-off seeder: for every built-in style template it derives the canonical
 * (and, for hero styles, bespoke) R2 URLs, verifies each one is actually
 * reachable, then writes the validated `StyleSampleVideo[]` onto the matching
 * system-team `styles` row.
 *
 * No fallbacks: if ANY expected URL is missing/unreachable the script lists
 * them and aborts WITHOUT touching the database. Run the render + upload first.
 *
 * Usage:
 *   bun scripts/seed-style-sample-videos.ts --local            # local D1
 *   bun scripts/seed-style-sample-videos.ts --test             # [env.test] D1
 *   bun scripts/seed-style-sample-videos.ts --d1               # prod D1 (HTTP, needs CLOUDFLARE_* token)
 *   bun scripts/seed-style-sample-videos.ts --local --dry-run  # validate only
 *   bun scripts/seed-style-sample-videos.ts --sql              # emit a .sql file (no DB connection)
 *
 * The --sql mode sidesteps the D1 HTTP token dance: it writes UPDATE statements
 * to a file you apply with your existing `wrangler login`, e.g.
 *   bunx wrangler d1 execute openstory-prd --remote --file=seed-sample-videos.sql
 * (swap --remote for --local against the dev DB). Output path overridable with
 * --out=<path>.
 */
import { styles, teams } from '@/lib/db/schema';
import type { StyleSampleVideo } from '@/lib/db/schema/libraries';
import { buildSampleVideos } from '@/lib/style/sample-videos';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { writeFile } from 'node:fs/promises';
import {
  createSeedDb,
  parseSeedTarget,
  type SeedTarget,
} from './seed-db-client';

const SYSTEM_TEAM_SLUG = 'system-templates';
const VALIDATION_CONCURRENCY = 10;

function getPublicAssetsDomain(): string {
  const domain = process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN;
  if (!domain) {
    throw new Error(
      'VITE_R2_PUBLIC_ASSETS_DOMAIN is required to build sample-video URLs'
    );
  }
  return domain;
}

/**
 * Fetch a URL's content hash (the R2 object's ETag) with a 1-byte ranged GET,
 * bypassing any stale edge cache so the hash reflects the origin object.
 * Returns the bare hex hash, `''` when reachable but ETag-less (can't version),
 * or `null` when unreachable.
 */
async function fetchContentHash(url: string): Promise<string | null> {
  try {
    const bust = `${url.includes('?') ? '&' : '?'}_seedhash=${Date.now()}`;
    const res = await fetch(`${url}${bust}`, {
      headers: { Range: 'bytes=0-0' },
    });
    if (!res.ok) return null; // 200 or 206 expected
    const etag = res.headers.get('etag');
    return etag ? etag.replace(/^W\//, '').replace(/"/g, '') : '';
  } catch {
    return null;
  }
}

/**
 * Validate every URL is reachable AND capture its content hash, batched.
 * Returns url → hash (`null` = unreachable). The hash cache-busts the
 * un-purgeable `cdn-cgi/media` transform: seeding `…/canonical.mp4?v=<hash>`
 * gives the transform a fresh cache key whenever the file's bytes change.
 */
async function hashAll(urls: string[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (let i = 0; i < urls.length; i += VALIDATION_CONCURRENCY) {
    const batch = urls.slice(i, i + VALIDATION_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => ({ url, hash: await fetchContentHash(url) }))
    );
    for (const { url, hash } of results) {
      process.stdout.write(hash === null ? 'x' : '.');
      hashes.set(url, hash);
    }
  }
  process.stdout.write('\n');
  return hashes;
}

type PlannedStyle = { name: string; entries: StyleSampleVideo[] };

/** SQL string literal with single quotes escaped (SQLite doubles them). */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Emit portable `UPDATE` statements that set each system-team style's
 * `sampleVideos` column — applied via `wrangler d1 execute` so no D1 HTTP API
 * token is needed. Table/column names are read from the drizzle schema (not
 * hardcoded) so they stay correct regardless of the casing convention. A style
 * missing from the DB simply matches zero rows (no-op), same as the live path.
 */
function generateSql(planned: PlannedStyle[]): string {
  const stylesTable = getTableConfig(styles).name;
  const teamsTable = getTableConfig(teams).name;
  const col = {
    sampleVideos: styles.sampleVideos.name,
    updatedAt: styles.updatedAt.name,
    name: styles.name.name,
    teamId: styles.teamId.name,
    teamsId: teams.id.name,
    teamsSlug: teams.slug.name,
  };
  // `updatedAt` is integer({ mode: 'timestamp' }) → seconds since epoch.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const teamFilter = `(SELECT "${col.teamsId}" FROM "${teamsTable}" WHERE "${col.teamsSlug}" = ${sqlString(SYSTEM_TEAM_SLUG)})`;

  const statements = planned.map(({ name, entries }) => {
    const json = JSON.stringify(entries);
    return (
      `UPDATE "${stylesTable}" SET ` +
      `"${col.sampleVideos}" = ${sqlString(json)}, ` +
      `"${col.updatedAt}" = ${nowSeconds} ` +
      `WHERE "${col.name}" = ${sqlString(name)} ` +
      `AND "${col.teamId}" = ${teamFilter};`
    );
  });

  return [
    '-- Seed styles.sampleVideos (issue #718).',
    '-- Generated by `bun scripts/seed-style-sample-videos.ts --sql`. Idempotent — safe to re-run.',
    `-- ${statements.length} system-team styles.`,
    '-- Apply with your existing wrangler login (no API token needed):',
    '--   bunx wrangler d1 execute openstory-prd --remote --file=<this file>',
    '--   (swap --remote for --local to target the local dev DB.)',
    '',
    ...statements,
    '',
  ].join('\n');
}

async function run(
  target: SeedTarget,
  opts: { dryRun: boolean; sql: boolean; outPath: string }
) {
  const domain = getPublicAssetsDomain();

  // 1. Build the intended entries for every template.
  const planned: PlannedStyle[] = DEFAULT_STYLE_TEMPLATES.map((style) => ({
    name: style.name,
    entries: buildSampleVideos({ domain, styleName: style.name }),
  }));

  const allUrls = planned.flatMap((p) => p.entries.map((e) => e.url));
  console.log(
    `Validating ${allUrls.length} URLs across ${planned.length} styles…`
  );

  // 2. Validate reachability + capture each file's content hash — abort loudly
  //    on any miss.
  const hashes = await hashAll(allUrls);
  const missing = [...hashes.entries()]
    .filter(([, hash]) => hash === null)
    .map(([url]) => url);
  if (missing.length > 0) {
    console.error(`\n❌ ${missing.length} sample video URL(s) unreachable:`);
    for (const url of missing) console.error(`   - ${url}`);
    console.error(
      '\nRun generate-style-sample-videos.ts + upload-style-sample-videos-to-r2.ts first. Aborting; no DB writes.'
    );
    process.exit(1);
  }
  console.log('✅ All sample video URLs reachable.\n');

  // 2b. Cache-bust the un-purgeable cdn-cgi/media transform by versioning each
  //     URL with its content hash. Content-addressed — an unchanged file keeps
  //     the same `?v=`, so only transforms whose bytes changed are refreshed.
  for (const plan of planned) {
    for (const entry of plan.entries) {
      const hash = hashes.get(entry.url);
      if (hash) entry.url = `${entry.url}?v=${hash}`;
    }
  }

  // 3a. SQL mode: write a portable .sql file and stop (no DB connection).
  if (opts.sql) {
    await writeFile(opts.outPath, generateSql(planned), 'utf8');
    const heroCount = planned.filter((p) => p.entries.length > 1).length;
    console.log(
      `📝 Wrote ${planned.length} UPDATE statement(s) (${heroCount} with bespoke) → ${opts.outPath}\n`
    );
    console.log('Apply with your existing wrangler login (no API token):');
    console.log(
      `  bunx wrangler d1 execute openstory-prd --remote --file=${opts.outPath}`
    );
    console.log('  (swap --remote for --local to target the local dev DB.)');
    return;
  }

  if (opts.dryRun) {
    const heroCount = planned.filter((p) => p.entries.length > 1).length;
    console.log(
      `Dry run — would update ${planned.length} styles (${heroCount} with bespoke). No DB writes.`
    );
    return;
  }

  // 3b. Write to DB directly (local/test/d1).
  const { db, dispose } = await createSeedDb(target);
  try {
    const [systemTeam]: { id: string }[] = await db
      .select()
      .from(teams)
      .where(eq(teams.slug, SYSTEM_TEAM_SLUG));
    if (!systemTeam) {
      throw new Error(
        `System team '${SYSTEM_TEAM_SLUG}' not found — run db:seed first.`
      );
    }

    const existing = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, systemTeam.id));
    const existingByName = new Map(existing.map((s) => [s.name, s]));

    let updated = 0;
    const notFound: string[] = [];
    for (const { name, entries } of planned) {
      const row = existingByName.get(name);
      if (!row) {
        notFound.push(name);
        continue;
      }
      await db
        .update(styles)
        .set({
          sampleVideos: entries satisfies StyleSampleVideo[],
          updatedAt: new Date(),
        })
        .where(eq(styles.id, row.id));
      updated++;
    }

    console.log(`✅ Updated sampleVideos on ${updated} style(s).`);
    if (notFound.length > 0) {
      console.error(
        `❌ ${notFound.length} template(s) had no matching DB row (run db:seed):`
      );
      for (const name of notFound) console.error(`   - ${name}`);
      process.exit(1);
    }
  } finally {
    await dispose();
  }
}

const argv = process.argv.slice(2);
const target = parseSeedTarget(argv);
const dryRun = argv.includes('--dry-run');
const sql = argv.includes('--sql');
const outArg = argv.find((a) => a.startsWith('--out='));
const outPath = outArg?.slice('--out='.length) || 'seed-sample-videos.sql';
await run(target, { dryRun, sql, outPath });
