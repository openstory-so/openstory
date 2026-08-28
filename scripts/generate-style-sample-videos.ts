/**
 * Generate style sample videos (issues #718, #801).
 *
 * Every sample renders through the REAL OpenStory pipeline via
 * `POST /api/v1/sequences` on the live site — scene split, character bible +
 * reference sheets, frame images, motion, music — so recurring people and
 * characters stay consistent across shots and every sample exercises the
 * production path end-to-end. There is no direct-fal fallback.
 *
 * CANONICAL sample (every style): the per-category one-liner brief is sent
 * with `enhance: 'always'` and the platform's script-enhancer expands it
 * server-side (~15s target). BESPOKE sample (~10 hero styles): curated beats
 * from BESPOKE_SCRIPTS, flattened to shot prose and sent verbatim
 * (`enhance: 'off'`). Hand-written CANONICAL_SCRIPT_OVERRIDES are also sent
 * verbatim.
 *
 * The per-frame clips are downloaded and concatenated into one mp4 via the
 * system `ffmpeg`. Music lands on the account as a sequence-level asset (mixed
 * client-side in the app) — it is not part of the frame clips, so the local
 * concat stays silent.
 *
 * Output (local, for review before upload):
 *   sample-videos/{slug}/canonical.mp4
 *   sample-videos/{slug}/bespoke.mp4              (hero styles only)
 *   sample-videos/{slug}/{kind}.sequence.json     (created sequence id, resumed on re-run)
 *   sample-videos/{slug}/{kind}.enhanced.txt      (canonical: platform-enhanced script)
 *   sample-videos/{slug}/_frames/*.webp|.mp4      (downloaded stills + clips)
 *
 * Without OPENSTORY_API_KEY the run is a dry-run (prints the resolved plan +
 * estimated spend so you see the bill first).
 *
 * Usage:
 *   OPENSTORY_API_KEY=osk_… bun scripts/generate-style-sample-videos.ts            # all styles
 *   OPENSTORY_API_KEY=osk_… bun scripts/generate-style-sample-videos.ts --submit-only
 *       # kick off all sequences (ids → {kind}.sequence.json), no polling;
 *       # re-run without --submit-only later to download + concat from the saved ids
 *   bun scripts/generate-style-sample-videos.ts --dry-run                          # cost preview
 *   …--filter "<name>" | --canonical-only | --bespoke-only | --hero-only | --force
 *
 * Env: OPENSTORY_API_URL (default https://openstory.so — the live site; set
 * http://localhost:3000 + `bun dev` to test against local) and
 * OPENSTORY_API_KEY (Settings → Developer; the key's team must have the
 * template styles seeded and enough credits — generation bills the platform).
 */
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { microsToUsd } from '@/lib/billing/money';
import { loadLocalFalPricing } from './load-local-fal-pricing';
import {
  aspectRatioSchema,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { calculateMotionMetadata } from '@/lib/motion/motion-generation';
import {
  createSampleSequence,
  orderedShotVideos,
  waitForSampleSequence,
  type SamplePipelineConfig,
} from './sample-pipeline';
import {
  beatsToScript,
  BESPOKE_SCRIPTS,
  briefForStyle,
  CANONICAL_SCRIPT_OVERRIDES,
  NOMINAL_BEAT_SECONDS,
  type SampleBeat,
} from '@/lib/style/sample-videos';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { concatClips, downloadTo } from './sample-media';

const FAL_PRICING = await loadLocalFalPricing();

const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');

/** Upper bound of the enhancer's 2-3 scene range — used for cost estimates. */
const CANONICAL_PLANNED_SCENES = 3;

const OPENSTORY_API_URL =
  process.env.OPENSTORY_API_URL ?? 'https://openstory.so';
const OPENSTORY_API_KEY = process.env.OPENSTORY_API_KEY;

/** Global clip progress across all jobs — `done/total` for render logging. */
const clipProgress = { done: 0, total: 0 };

type Flags = {
  /** Style names/slugs to include; empty = all. `--filter` accepts a comma list. */
  filters: string[];
  canonicalOnly: boolean;
  bespokeOnly: boolean;
  heroOnly: boolean;
  force: boolean;
  dryRun: boolean;
  submitOnly: boolean;
  /** Images-only render: no image-to-video clips, no music. */
  noMotion: boolean;
  /** Override every job's image model (key in IMAGE_MODELS); null = per-style. */
  imageModel: string | null;
};

function parseFlags(argv: string[]): Flags {
  const filterIdx = argv.findIndex((a) => a === '--filter');
  const filterRaw = filterIdx >= 0 ? (argv[filterIdx + 1]?.trim() ?? '') : '';
  const imageModelIdx = argv.findIndex((a) => a === '--image-model');
  const imageModelRaw =
    imageModelIdx >= 0 ? (argv[imageModelIdx + 1]?.trim() ?? '') : '';
  return {
    imageModel: imageModelRaw || null,
    filters: filterRaw
      ? filterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    canonicalOnly: argv.includes('--canonical-only'),
    bespokeOnly: argv.includes('--bespoke-only'),
    heroOnly: argv.includes('--hero-only'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    submitOnly: argv.includes('--submit-only'),
    noMotion: argv.includes('--no-motion'),
  };
}

type RenderJob = {
  styleName: string;
  category: string | null;
  tags: string[];
  slug: string;
  kind: 'canonical' | 'bespoke';
  imageModel: TextToImageModel;
  videoModel: ImageToVideoModel;
  aspectRatio: AspectRatio;
  outputPath: string;
  force: boolean;
  /** Images-only render when false — no motion clips, no music. */
  motion: boolean;
  /** Canonical only: the platform enhances this per-category brief. */
  brief?: string;
  /** Bespoke only: curated beats, sent verbatim (no enhancement). */
  curatedBeats?: SampleBeat[];
  /** Scene count used for cost estimates before the platform's scene split. */
  plannedScenes: number;
};

function buildJobs(flags: Flags): RenderJob[] {
  const filterSet = flags.filters.length ? new Set(flags.filters) : null;
  const jobs: RenderJob[] = [];
  for (const style of DEFAULT_STYLE_TEMPLATES) {
    const slug = styleSlug(style.name);
    if (filterSet && !filterSet.has(style.name) && !filterSet.has(slug)) {
      continue;
    }
    const bespoke = BESPOKE_SCRIPTS[slug];
    if (flags.heroOnly && !bespoke) continue;

    if (flags.imageModel && !(flags.imageModel in IMAGE_MODELS)) {
      throw new Error(
        `Unknown --image-model "${flags.imageModel}". Keys: ${Object.keys(IMAGE_MODELS).join(', ')}`
      );
    }
    const imageModel = flags.imageModel
      ? safeTextToImageModel(flags.imageModel, DEFAULT_IMAGE_MODEL)
      : safeTextToImageModel(style.recommendedImageModel, DEFAULT_IMAGE_MODEL);
    const videoModel = safeImageToVideoModel(style.recommendedVideoModel);
    const aspectRatio = aspectRatioSchema
      .catch('16:9')
      .parse(style.defaultAspectRatio ?? '16:9');
    const styleDir = path.join(OUTPUT_DIR, slug);

    const common = {
      styleName: style.name,
      category: style.category ?? null,
      tags: style.tags ?? [],
      slug,
      imageModel,
      videoModel,
      aspectRatio,
      force: flags.force,
      motion: !flags.noMotion,
    };

    if (!flags.bespokeOnly) {
      jobs.push({
        ...common,
        kind: 'canonical',
        brief: briefForStyle(style),
        plannedScenes: CANONICAL_PLANNED_SCENES,
        outputPath: path.join(styleDir, 'canonical.mp4'),
      });
    }
    if (bespoke && !flags.canonicalOnly) {
      jobs.push({
        ...common,
        kind: 'bespoke',
        curatedBeats: bespoke,
        plannedScenes: bespoke.length,
        outputPath: path.join(styleDir, 'bespoke.mp4'),
      });
    }
  }
  return jobs;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a job sends to `POST /api/v1/sequences`. Bespoke beats and hand-written
 * overrides are already-reviewed prose → sent verbatim (`enhance: 'off'`).
 * Other canonicals send the raw brief with `enhance: 'always'` so the LIVE
 * SITE's script-enhancer expands it — no local LLM involved.
 */
function preparePipelineRequest(job: RenderJob): {
  script: string;
  enhance: 'always' | 'off';
  targetSeconds?: number;
} {
  if (job.curatedBeats) {
    return { script: beatsToScript(job.curatedBeats), enhance: 'off' };
  }
  const override = CANONICAL_SCRIPT_OVERRIDES[job.slug];
  if (override) return { script: override.enhancedScript, enhance: 'off' };
  if (!job.brief) throw new Error(`Canonical job ${job.slug} has no brief`);
  return {
    script: job.brief,
    enhance: 'always',
    targetSeconds: CANONICAL_PLANNED_SCENES * NOMINAL_BEAT_SECONDS,
  };
}

/** Where a job persists its created sequence id (submit/resume). */
function sequenceJsonPath(job: RenderJob): string {
  return path.join(path.dirname(job.outputPath), `${job.kind}.sequence.json`);
}

const savedSequenceSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  baseUrl: z.string(),
  createdAt: z.string(),
});

function pipelineApi(): SamplePipelineConfig {
  if (!OPENSTORY_API_KEY) {
    throw new Error(
      `set OPENSTORY_API_KEY (and OPENSTORY_API_URL, default ${OPENSTORY_API_URL}) to render`
    );
  }
  return { baseUrl: OPENSTORY_API_URL, apiKey: OPENSTORY_API_KEY };
}

/**
 * Create the job's sequence on the platform — or resume the one a previous
 * run already created (`{kind}.sequence.json`), so a `--submit-only` pass (or
 * a crashed run) is picked up later without re-creating/re-billing. `--force`
 * ignores the saved id and creates a fresh sequence.
 */
async function ensureSampleSequence(
  job: RenderJob,
  api: SamplePipelineConfig
): Promise<string> {
  const seqPath = sequenceJsonPath(job);
  if (!job.force && (await fileExists(seqPath))) {
    const saved = savedSequenceSchema.safeParse(
      JSON.parse(await readFile(seqPath, 'utf-8'))
    );
    if (saved.success && saved.data.baseUrl === api.baseUrl) {
      console.log(
        `   ↩️  ${job.slug}/${job.kind} resuming sequence ${saved.data.id} (from ${path.relative(process.cwd(), seqPath)})`
      );
      return saved.data.id;
    }
  }

  const request = preparePipelineRequest(job);
  const { id, workflowRunId, enhancedScript } = await createSampleSequence(
    api,
    {
      ...request,
      title: `Style sample — ${job.styleName} (${job.kind})`,
      styleName: job.styleName,
      aspectRatio: job.aspectRatio,
      imageModel: job.imageModel,
      videoModel: job.videoModel,
      motion: job.motion,
    }
  );
  console.log(
    `   📤 ${job.slug}/${job.kind} sequence ${id} created via ${api.baseUrl}`
  );
  await mkdir(path.dirname(seqPath), { recursive: true });
  await writeFile(
    seqPath,
    JSON.stringify(
      {
        id,
        workflowRunId,
        baseUrl: api.baseUrl,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  // Persist the platform-enhanced script for the record (review happens after
  // the fact — there's no local pre-render review step).
  if (enhancedScript) {
    await writeFile(
      path.join(path.dirname(job.outputPath), `${job.kind}.enhanced.txt`),
      enhancedScript
    );
  }
  return id;
}

/**
 * One sequence through the real OpenStory pipeline: create (or resume), wait
 * for every frame video, then download the per-frame clips for the local
 * concat. The platform has no server-side assembly (final export is
 * client-side), so concatenation stays here.
 */
async function renderJobViaPipeline(
  job: RenderJob,
  framesDir: string
): Promise<string[]> {
  const api = pipelineApi();
  const id = await ensureSampleSequence(job, api);

  // Frames appear incrementally while scene-split streams, so track the
  // count delta rather than latching the first non-zero value.
  let shotsCounted = 0;
  let videosCounted = 0;
  const state = await waitForSampleSequence(api, {
    id,
    onProgress: (p) => {
      if (p.shots > shotsCounted) {
        clipProgress.total += p.shots - shotsCounted;
        shotsCounted = p.shots;
      }
      const newlyReady = Math.max(0, p.videosReady - videosCounted);
      videosCounted += newlyReady;
      clipProgress.done += newlyReady;
      console.log(
        `   ⏳ ${job.slug}/${job.kind} [${p.status}] images ${p.imagesReady}/${p.shots}, ` +
          `clips ${p.videosReady}/${p.shots}` +
          (p.videosFailed > 0 ? `, ${p.videosFailed} FAILED` : '') +
          ` — ${clipProgress.done}/${clipProgress.total} clips overall`
      );
    },
  });

  // A non-completed status with every clip ready is tolerated by
  // waitForSampleSequence (e.g. `instance.in_finite_state` poisoning where the
  // failure was written after all the work landed) — surface it but proceed.
  if (state.status !== 'completed') {
    console.warn(
      `   ⚠️  ${job.slug}/${job.kind} sequence ${id} ended ${state.status} but all clips rendered — using them`
    );
  }

  // Download per-frame clips (+ stills, review-only) in playback order.
  const frames = orderedShotVideos(state);
  return Promise.all(
    frames.map(async (frame, i) => {
      const base = `${String(i + 1).padStart(2, '0')}-${frame.shotId}`;
      if (frame.imageUrl) {
        const ext = path.extname(new URL(frame.imageUrl).pathname) || '.webp';
        await downloadTo(frame.imageUrl, path.join(framesDir, base + ext));
      }
      const clipPath = path.join(framesDir, `${base}.mp4`);
      await downloadTo(frame.videoUrl, clipPath);
      return clipPath;
    })
  );
}

async function renderJob(job: RenderJob, submitOnly: boolean): Promise<void> {
  if (!job.force && (await fileExists(job.outputPath))) {
    console.log(`⏭️  ${job.slug}/${job.kind} exists — skipping (use --force)`);
    return;
  }
  // Fire-and-forget: create the sequence on the platform, persist its id, and
  // exit — a later run (without --submit-only) resumes from the saved id to
  // poll + download + concat.
  if (submitOnly) {
    await ensureSampleSequence(job, pipelineApi());
    return;
  }
  const framesDir = path.join(
    path.dirname(job.outputPath),
    '_frames',
    job.kind
  );
  await mkdir(framesDir, { recursive: true });

  const clipPaths = await renderJobViaPipeline(job, framesDir);

  await mkdir(path.dirname(job.outputPath), { recursive: true });
  await concatClips(clipPaths, job.outputPath);
  await rm(path.join(framesDir, 'concat.txt'), { force: true });
  console.log(
    `✅ ${job.slug}/${job.kind} → ${path.relative(process.cwd(), job.outputPath)}`
  );
}

/**
 * Rough motion-cost indicator (raw model price × planned scenes). Generation
 * bills the API key's team in platform credits — images, motion, and music —
 * so the real bill is higher; this is only a relative size of the run.
 *
 * Models we can't price yet return null. They are counted separately rather
 * than added as $0: this figure is printed to an operator about to spend real
 * money, and "unknown" silently reading as "free" is exactly the #1069 error.
 */
function estimateCost(jobs: RenderJob[]): { usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const job of jobs) {
    const { cost } = calculateMotionMetadata(
      {
        imageUrl: 'https://example.com/x.webp',
        prompt: 'sample',
        model: job.videoModel,
        duration: NOMINAL_BEAT_SECONDS,
        aspectRatio: job.aspectRatio,
        generateAudio: false,
      },
      FAL_PRICING
    );
    if (cost == null) {
      unpriced += 1;
      continue;
    }
    usd += microsToUsd(cost) * job.plannedScenes;
  }
  return { usd, unpriced };
}

/** Renders the indicator as a lower bound when some models are unpriced. */
function formatCostIndicator(jobs: RenderJob[]): string {
  const { usd, unpriced } = estimateCost(jobs);
  const amount = `$${usd.toFixed(2)}`;
  return unpriced > 0
    ? `≥ ${amount} (${unpriced} job(s) on unpriced models — excluded)`
    : `≈ ${amount}`;
}

function printDryRun(jobs: RenderJob[]) {
  console.log('🔍 Dry run — no generation. Resolved plan:\n');
  const byStyle = new Map<string, RenderJob[]>();
  for (const job of jobs) {
    byStyle.set(job.slug, [...(byStyle.get(job.slug) ?? []), job]);
  }
  for (const [slug, styleJobs] of byStyle) {
    const first = styleJobs[0];
    if (!first) continue;
    console.log(
      `• ${first.styleName} (${slug}) — image:${IMAGE_MODELS[first.imageModel].name}, ` +
        `video:${IMAGE_TO_VIDEO_MODELS[first.videoModel].name}, ${first.aspectRatio}`
    );
    for (const job of styleJobs) {
      const scriptOverride = CANONICAL_SCRIPT_OVERRIDES[job.slug];
      const detail =
        job.kind === 'canonical'
          ? scriptOverride
            ? `verbatim single-shot script, enhance:off — "${job.brief}"`
            : `brief: "${job.brief}" → ~${job.plannedScenes} scenes (platform-enhanced)`
          : `${job.plannedScenes} curated beats`;
      console.log(`    ${job.kind}: ${detail} × ${NOMINAL_BEAT_SECONDS}s`);
    }
  }
  const clips = jobs.reduce((n, j) => n + j.plannedScenes, 0);
  console.log(
    `\nTotals: ${byStyle.size} styles, ${jobs.length} videos, ~${clips} clips ` +
      `(+~${clips} image gens + music per sequence), all via the OpenStory pipeline ` +
      `at ${OPENSTORY_API_URL}. Motion-cost indicator ${formatCostIndicator(jobs)} ` +
      `(bills the API key's team in credits).`
  );
  if (!OPENSTORY_API_KEY) {
    console.log('\n(OPENSTORY_API_KEY not set — set it to actually render.)');
  }
}

/**
 * Launch every job at once; each creates its sequence and long-polls
 * independently — the platform's own queue absorbs the backlog. Failures are
 * collected without aborting the rest.
 */
async function runPool(jobs: RenderJob[], submitOnly: boolean) {
  const failures: { slug: string; kind: string; error: string }[] = [];
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await renderJob(job, submitOnly);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${job.slug}/${job.kind}: ${message}`);
        failures.push({ slug: job.slug, kind: job.kind, error: message });
      }
    })
  );
  return failures;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const jobs = buildJobs(flags);

  if (jobs.length === 0) {
    console.error('No matching styles. Check --filter / flags.');
    process.exit(1);
  }

  // Images-only renders produce no clips, so the poll/download/concat path
  // (which requires a video URL per frame) can't complete — only submitting is
  // meaningful. Review the stills in the app via each sequence id.
  if (flags.noMotion && !flags.submitOnly && !flags.dryRun) {
    console.error('--no-motion requires --submit-only (no clips to download).');
    process.exit(1);
  }

  if (flags.dryRun || !OPENSTORY_API_KEY) {
    printDryRun(jobs);
    return;
  }

  console.log(
    flags.submitOnly
      ? `🚀 Submitting ${jobs.length} sequence(s) to the OpenStory pipeline (${OPENSTORY_API_URL}) — ` +
          `no polling; ids land in sample-videos/{slug}/{kind}.sequence.json. ` +
          `Motion-cost indicator ${formatCostIndicator(jobs)} (bills the API key's team)\n`
      : `🎬 Rendering ${jobs.length} videos via the OpenStory pipeline (${OPENSTORY_API_URL}). ` +
          `Motion-cost indicator ${formatCostIndicator(jobs)} (bills the API key's team)\n`
  );
  await mkdir(OUTPUT_DIR, { recursive: true });
  const failures = await runPool(jobs, flags.submitOnly);

  console.log(
    `\nDone: ${jobs.length - failures.length}/${jobs.length} ` +
      (flags.submitOnly
        ? 'submitted. Re-run without --submit-only to download + concat once they finish.'
        : 'succeeded.')
  );
  if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const f of failures)
      console.error(`   - ${f.slug}/${f.kind}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
