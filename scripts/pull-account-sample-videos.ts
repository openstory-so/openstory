/**
 * Harvest the most recent fully-rendered sequence per style from the API key's
 * own account and assemble each into `sample-videos/{slug}/canonical.mp4`.
 *
 * Unlike `generate-style-sample-videos.ts` (which RENDERS fresh sequences via
 * the pipeline, billing credits), this reads sequences that already exist on
 * the account — videos the user already made — and just downloads + concatenates
 * them. Use it to refresh the sample library from known-good account content.
 *
 * GET /api/v1/sequences (most-recent-first, cursor-paginated) → group by the
 * resolved style → pick the newest sequence whose every frame clip is ready →
 * GET its detail → download each clip in order → ffmpeg concat. Reuses
 * `sample-pipeline.ts` (fetch + validate + order) and `sample-media.ts`
 * (download + concat).
 *
 * Output (per chosen sequence):
 *   sample-videos/{slug}/canonical.mp4
 *   sample-videos/{slug}/canonical.source.json    provenance (sequence id, style, createdAt)
 *   sample-videos/{slug}/_frames/pulled/*.mp4      downloaded clips
 *
 * Usage (bun does NOT autoload `.env.admin`):
 *   bun --env-file=.env.admin scripts/pull-account-sample-videos.ts            # all styles
 *   bun --env-file=.env.admin scripts/pull-account-sample-videos.ts --plan     # report only, no downloads
 *   bun --env-file=.env.admin scripts/pull-account-sample-videos.ts --filter "Podcast Clip,gym-selfie-cam"
 *   bun --env-file=.env.admin scripts/pull-account-sample-videos.ts --force    # overwrite existing canonical.mp4
 *
 * Env: OPENSTORY_API_URL (default https://openstory.so), OPENSTORY_API_KEY.
 */

import { styleSlug } from '@/lib/style/style-slug';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { concatClips, downloadTo } from './sample-media';
import {
  orderedShotVideos,
  type SamplePipelineConfig,
  waitForSampleSequence,
} from './sample-pipeline';

const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const OPENSTORY_API_URL =
  process.env.OPENSTORY_API_URL ?? 'https://openstory.so';
const OPENSTORY_API_KEY = process.env.OPENSTORY_API_KEY;

/** Page size for listing — the API caps `limit` at 100. */
const PAGE_LIMIT = 100;
/** Styles processed at once (download + ffmpeg per style). */
const CONCURRENCY = 5;

/** The slice of a list entry we consume (lenient — the API is additive). */
const listItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  style: z.object({ id: z.string(), name: z.string().nullable() }),
  counts: z.object({
    shots: z.number(),
    imagesReady: z.number(),
    videosReady: z.number(),
    videosFailed: z.number(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type SequenceListItem = z.infer<typeof listItemSchema>;

const listPageSchema = z.object({
  sequences: z.array(listItemSchema),
  _links: z.object({ next: z.object({ href: z.string() }).optional() }),
});

type Flags = {
  /** Style names/slugs to include; empty = all. */
  filters: string[];
  plan: boolean;
  force: boolean;
};

function parseFlags(argv: string[]): Flags {
  const filterIdx = argv.findIndex((a) => a === '--filter');
  const filterRaw = filterIdx >= 0 ? (argv[filterIdx + 1]?.trim() ?? '') : '';
  return {
    filters: filterRaw
      ? filterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    plan: argv.includes('--plan'),
    force: argv.includes('--force'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a public-API path (absolute or `/api/...`), retrying once on 429. */
async function apiGet(href: string, apiKey: string): Promise<unknown> {
  const url = href.startsWith('http') ? href : `${OPENSTORY_API_URL}${href}`;
  const init = { headers: { 'x-api-key': apiKey } };
  let res = await fetch(url, init);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 200);
    res = await fetch(url, init);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`GET ${url} failed (${res.status}): ${body}`);
  }
  return res.json();
}

/** Walk every page of the team's sequences, most-recent-first. */
async function listAllSequences(apiKey: string): Promise<SequenceListItem[]> {
  const all: SequenceListItem[] = [];
  let href: string | null = `/api/v1/sequences?limit=${PAGE_LIMIT}`;
  let page = 0;
  while (href) {
    const parsed = listPageSchema.parse(await apiGet(href, apiKey));
    all.push(...parsed.sequences);
    page += 1;
    process.stdout.write(
      `\r📥 listing… ${all.length} sequences (${page} page${page === 1 ? '' : 's'})`
    );
    href = parsed._links.next?.href ?? null;
  }
  process.stdout.write('\n');
  return all;
}

/** Every shot clip rendered — the bar a sample must clear. */
function isReady(item: SequenceListItem): boolean {
  const { shots, videosReady, videosFailed } = item.counts;
  return shots > 0 && videosReady >= shots && videosFailed === 0;
}

type StylePick = {
  slug: string;
  styleName: string;
  chosen: SequenceListItem;
  /** Newer sequence(s) for this style that weren't fully rendered, so skipped. */
  skippedNewer: number;
};

/**
 * Group sequences by their resolved style's slug and pick, per style, the most
 * recently *created* sequence whose every clip is ready. A style whose newest
 * sequence isn't fully rendered falls back to its newest ready one (and reports
 * how many newer ones were skipped); a style with no ready sequence at all is
 * reported and produces no pick.
 */
function pickPerStyle(items: SequenceListItem[]): {
  picks: StylePick[];
  noReady: { slug: string; styleName: string; total: number }[];
  nameless: number;
} {
  const bySlug = new Map<
    string,
    { styleName: string; items: SequenceListItem[] }
  >();
  let nameless = 0;
  for (const item of items) {
    if (item.style.name === null) {
      // styleId is a notNull FK, so a null name is a genuine data anomaly
      // (style row missing) — surface it rather than guessing a slug.
      nameless += 1;
      console.warn(
        `⚠️  sequence ${item.id} ("${item.title}") has style ${item.style.id} with no name — skipping`
      );
      continue;
    }
    const slug = styleSlug(item.style.name);
    const bucket = bySlug.get(slug);
    if (bucket) bucket.items.push(item);
    else bySlug.set(slug, { styleName: item.style.name, items: [item] });
  }

  const picks: StylePick[] = [];
  const noReady: { slug: string; styleName: string; total: number }[] = [];
  for (const [slug, { styleName, items: group }] of bySlug) {
    const byNewest = [...group].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const chosenIdx = byNewest.findIndex(isReady);
    if (chosenIdx === -1) {
      noReady.push({ slug, styleName, total: group.length });
      continue;
    }
    const chosen = byNewest[chosenIdx];
    if (!chosen) continue;
    picks.push({ slug, styleName, chosen, skippedNewer: chosenIdx });
  }
  picks.sort((a, b) => a.slug.localeCompare(b.slug));
  return { picks, noReady, nameless };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Download a pick's clips and concat into `sample-videos/{slug}/canonical.mp4`. */
async function harvestPick(
  pick: StylePick,
  api: SamplePipelineConfig,
  force: boolean
): Promise<'written' | 'skipped'> {
  const styleDir = path.join(OUTPUT_DIR, pick.slug);
  const outputPath = path.join(styleDir, 'canonical.mp4');
  if (!force && (await fileExists(outputPath))) {
    console.log(`⏭️  ${pick.slug} exists — skipping (use --force)`);
    return 'skipped';
  }

  // Single GET that also asserts every clip is actually ready end-to-end; the
  // sequence is already terminal, so this returns immediately rather than
  // long-polling.
  const state = await waitForSampleSequence(api, {
    id: pick.chosen.id,
    timeoutMs: 60_000,
    pollDelayMs: 0,
  });
  const frames = orderedShotVideos(state);

  const framesDir = path.join(styleDir, '_frames', 'pulled');
  await mkdir(framesDir, { recursive: true });
  const clipPaths = await Promise.all(
    frames.map(async (frame, i) => {
      const clipPath = path.join(
        framesDir,
        `${String(i + 1).padStart(2, '0')}-${frame.shotId}.mp4`
      );
      await downloadTo(frame.videoUrl, clipPath);
      return clipPath;
    })
  );

  await concatClips(clipPaths, outputPath);
  await rm(path.join(framesDir, 'concat.txt'), { force: true });
  await writeFile(
    path.join(styleDir, 'canonical.source.json'),
    `${JSON.stringify(
      {
        sequenceId: pick.chosen.id,
        title: pick.chosen.title,
        styleId: pick.chosen.style.id,
        styleName: pick.styleName,
        status: pick.chosen.status,
        createdAt: pick.chosen.createdAt,
        frames: clipPaths.length,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `✅ ${pick.slug} → canonical.mp4 (${clipPaths.length} clips, seq ${pick.chosen.id})`
  );
  return 'written';
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item !== undefined) await fn(item);
      }
    })()
  );
  await Promise.all(workers);
}

function applyFilter(picks: StylePick[], filters: string[]): StylePick[] {
  if (filters.length === 0) return picks;
  const set = new Set(filters);
  return picks.filter((p) => set.has(p.slug) || set.has(p.styleName));
}

async function main() {
  if (!OPENSTORY_API_KEY) {
    console.error(
      'OPENSTORY_API_KEY not set. Run with `bun --env-file=.env.admin scripts/pull-account-sample-videos.ts`.'
    );
    process.exit(1);
  }
  const apiKey = OPENSTORY_API_KEY; // narrowed to string by the guard above
  const flags = parseFlags(process.argv.slice(2));

  console.log(`🔎 Reading sequences from ${OPENSTORY_API_URL}…`);
  const sequences = await listAllSequences(apiKey);
  const { picks: allPicks, noReady, nameless } = pickPerStyle(sequences);
  const picks = applyFilter(allPicks, flags.filters);

  console.log(
    `\n📊 ${sequences.length} sequences → ${allPicks.length} styles with a ready video` +
      (flags.filters.length ? ` (${picks.length} after --filter)` : '') +
      `, ${noReady.length} styles with none ready` +
      (nameless ? `, ${nameless} sequences skipped (no style name)` : '') +
      '.\n'
  );

  for (const pick of picks) {
    const note =
      pick.skippedNewer > 0
        ? ` (newest ready; ${pick.skippedNewer} newer not fully rendered)`
        : '';
    console.log(
      `• ${pick.slug} ← "${pick.chosen.title}" [${pick.chosen.status}] ` +
        `${pick.chosen.counts.shots} clips, ${pick.chosen.createdAt}${note}`
    );
  }
  if (noReady.length > 0) {
    console.log(
      `\n⚠️  No fully-rendered sequence for: ${noReady
        .map((n) => `${n.slug} (${n.total} seq)`)
        .join(', ')}`
    );
  }

  if (flags.plan) {
    console.log('\n🔍 Plan only (--plan) — no downloads.');
    return;
  }
  if (picks.length === 0) {
    console.log('\nNothing to harvest.');
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const api: SamplePipelineConfig = {
    baseUrl: OPENSTORY_API_URL,
    apiKey,
  };
  let written = 0;
  let skipped = 0;
  const failures: { slug: string; error: string }[] = [];
  console.log(`\n🎬 Harvesting ${picks.length} style sample(s)…\n`);
  await mapPool(picks, CONCURRENCY, async (pick) => {
    try {
      const result = await harvestPick(pick, api, flags.force);
      if (result === 'written') written += 1;
      else skipped += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${pick.slug}: ${message}`);
      failures.push({ slug: pick.slug, error: message });
    }
  });

  console.log(
    `\nDone: ${written} written, ${skipped} skipped, ${failures.length} failed.`
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
