/**
 * Preview harvested style sample videos in LOCAL dev — without uploading to the
 * production assets bucket.
 *
 * The prod path (`upload-style-sample-videos-to-r2.ts` → `seed-…:d1`) pushes
 * `sample-videos/{slug}/{kind}.mp4` to the public CDN and stores absolute
 * `https://{assets-domain}/styles/{slug}/{kind}.mp4` URLs. This script does the
 * local equivalent so you can eyeball the videos before committing to that:
 *
 *   1. PUT each local `sample-videos/{slug}/{kind}.mp4` into the local Miniflare
 *      media bucket (`R2_STORAGE_BUCKET`) at key `styles/{slug}/{kind}.mp4`.
 *   2. Set the matching system-team `styles.sampleVideos` to ORIGIN-RELATIVE
 *      `/r2/styles/{slug}/{kind}.mp4` URLs.
 *
 * The `/r2/$` route streams those keys straight from the binding in local dev
 * (no `R2_PUBLIC_STORAGE_DOMAIN` set), and the showcase's `optimizedVideoUrl`
 * leaves relative URLs untouched — so the app plays your local files directly.
 *
 * It writes to the same `.wrangler/state` that `bun dev` uses, so just refresh
 * the running app afterward. Reversible: re-run the real seed
 * (`bun run styles:sample-videos:seed:local`) to restore CDN URLs.
 *
 * Usage:
 *   bun scripts/preview-style-sample-videos-local.ts             # all found, local D1
 *   bun scripts/preview-style-sample-videos-local.ts --test      # [env.test] D1
 *   bun scripts/preview-style-sample-videos-local.ts --filter podcast-clip
 *   bun scripts/preview-style-sample-videos-local.ts --dry-run   # plan only, no writes
 */

import { styles, teams } from '@/lib/db/schema';
import type { StyleSampleVideo } from '@/lib/db/schema/libraries';
import { buildSampleVideos } from '@/lib/style/sample-videos';
import { styleSlug } from '@/shared/style/style-slug';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getLocalPlatformProxy } from './local-platform-proxy';

const SAMPLE_DIR = path.join(process.cwd(), 'sample-videos');
const SYSTEM_TEAM_SLUG = 'system-templates';

type ProxyEnv = { DB?: D1Database; R2_STORAGE_BUCKET?: R2Bucket };

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const environment = argv.includes('--test') ? 'test' : undefined;
const filterIdx = argv.findIndex((a) => a === '--filter');
const filter = filterIdx >= 0 ? argv[filterIdx + 1]?.trim() : undefined;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A local sample to load: its slug, the style row's name, and on-disk kinds. */
type LocalSample = {
  slug: string;
  styleName: string;
  /** `buildSampleVideos` entries whose `{kind}.mp4` actually exists on disk. */
  entries: StyleSampleVideo[];
};

/**
 * Match `sample-videos/{slug}/` dirs to system-team style rows by slug, keeping
 * only the kinds whose file exists. Reuses `buildSampleVideos` for each entry's
 * label/duration/order, then rewrites the URL to the origin-relative `/r2` key.
 */
async function collectSamples(
  styleNameBySlug: Map<string, string>
): Promise<{ samples: LocalSample[]; orphanSlugs: string[] }> {
  if (!(await exists(SAMPLE_DIR))) {
    throw new Error(
      `${SAMPLE_DIR} not found — run pull-account-sample-videos.ts first.`
    );
  }
  const slugs = (await readdir(SAMPLE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((slug) => !filter || slug === filter);

  const samples: LocalSample[] = [];
  const orphanSlugs: string[] = [];
  for (const slug of slugs) {
    const styleName = styleNameBySlug.get(slug);
    if (!styleName) {
      orphanSlugs.push(slug);
      continue;
    }
    const planned = buildSampleVideos({ domain: 'local', styleName });
    const entries: StyleSampleVideo[] = [];
    for (const entry of planned) {
      if (await exists(path.join(SAMPLE_DIR, slug, `${entry.kind}.mp4`))) {
        entries.push({ ...entry, url: `/r2/styles/${slug}/${entry.kind}.mp4` });
      }
    }
    if (entries.length > 0) samples.push({ slug, styleName, entries });
  }
  return { samples, orphanSlugs };
}

async function main() {
  const proxy = await getLocalPlatformProxy<ProxyEnv>({ environment });
  try {
    const bucket = proxy.env.R2_STORAGE_BUCKET;
    const d1 = proxy.env.DB;
    if (!bucket) throw new Error('R2 binding "R2_STORAGE_BUCKET" missing.');
    if (!d1) throw new Error('D1 binding "DB" missing.');
    const db = drizzle(d1);

    const [systemTeam]: { id: string }[] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.slug, SYSTEM_TEAM_SLUG));
    if (!systemTeam) {
      throw new Error(
        `System team '${SYSTEM_TEAM_SLUG}' not found — run db:seed first.`
      );
    }

    const styleRows = await db
      .select({ id: styles.id, name: styles.name })
      .from(styles)
      .where(eq(styles.teamId, systemTeam.id));
    const idBySlug = new Map(styleRows.map((s) => [styleSlug(s.name), s.id]));
    const nameBySlug = new Map(
      styleRows.map((s) => [styleSlug(s.name), s.name])
    );

    const { samples, orphanSlugs } = await collectSamples(nameBySlug);
    if (samples.length === 0) {
      console.log('No matching local sample videos found.');
      if (orphanSlugs.length > 0) {
        console.log(`(unmatched dirs: ${orphanSlugs.join(', ')})`);
      }
      return;
    }

    console.log(
      `${isDryRun ? '🔍 Plan' : '🎬 Loading'} ${samples.length} style sample(s) into local ${environment ?? 'default'} env\n`
    );

    let loaded = 0;
    for (const sample of samples) {
      const id = idBySlug.get(sample.slug);
      if (!id) continue; // unreachable (nameBySlug ⊇ idBySlug), keeps types happy
      const kinds = sample.entries.map((e) => e.kind).join('+');
      if (isDryRun) {
        console.log(`• ${sample.slug} ← ${kinds} → ${sample.entries[0]?.url}`);
        continue;
      }
      for (const entry of sample.entries) {
        const file = path.join(SAMPLE_DIR, sample.slug, `${entry.kind}.mp4`);
        await bucket.put(
          `styles/${sample.slug}/${entry.kind}.mp4`,
          await readFile(file),
          {
            httpMetadata: { contentType: 'video/mp4' },
          }
        );
      }
      await db
        .update(styles)
        .set({ sampleVideos: sample.entries, updatedAt: new Date() })
        .where(eq(styles.id, id));
      loaded += 1;
      console.log(`✅ ${sample.slug} (${kinds})`);
    }

    if (orphanSlugs.length > 0) {
      console.log(
        `\n⚠️  ${orphanSlugs.length} dir(s) had no system-team style: ${orphanSlugs.join(', ')}`
      );
    }
    console.log(
      isDryRun
        ? '\nDry run — no R2/D1 writes.'
        : `\nDone: ${loaded} style(s) now play local files. Refresh the running app.`
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
