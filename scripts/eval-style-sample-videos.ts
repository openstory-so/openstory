/**
 * Eval harness for the rendered style sample videos (sibling to
 * `generate-style-sample-videos.ts`). For each `sample-videos/<slug>/<kind>.mp4`
 * it does two things:
 *
 *   1. A free, model-free MOTION metric (ffmpeg frame-differencing) — the
 *      "is anything actually happening" signal. A near-static clip is the
 *      "boring sample" problem in numbers, before any API spend.
 *   2. A vision-LLM RUBRIC: samples N evenly-spaced frames and sends them to a
 *      Gemini/Grok vision model via OpenRouter with the style's intended look +
 *      the brief, scoring style adherence, liveliness, character consistency
 *      (the #801 goal — same person across cuts), and coherence/artifacts.
 *
 * Writes `sample-videos/eval-scores.json` and prints a worst-first table.
 *
 * Script-only (not imported by the app). Calls OpenRouter's REST endpoint
 * directly so it carries no worker-env dependency.
 *
 *   OPENROUTER_KEY=… bun --env-file=.env.admin scripts/eval-style-sample-videos.ts
 *   …--filter <slug> | --model google/gemini-3.1-pro-preview | --frames 8 | --limit 5 | --motion-only
 *
 * Default model: google/gemini-3.5-flash (cheap, strong vision). Override with
 * --model (e.g. google/gemini-3.1-pro-preview, x-ai/grok-4.6).
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { styleSlug } from '@/lib/style/style-slug';
import { z } from 'zod';

const run = promisify(execFile);

// Mutable so `--dir <path>` can retarget a versioned sample set
// (e.g. `sample-videos-v2`); reassigned in main() before any path is built.
let OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

type Flags = {
  dir: string | null;
  out: string | null;
  filter: string | null;
  model: string;
  frames: number;
  limit: number | null;
  motionOnly: boolean;
  concurrency: number;
};

function parseFlags(argv: string[]): Flags {
  const valueAfter = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1]?.trim() ?? null) : null;
  };
  const num = (flag: string, fallback: number): number => {
    const v = valueAfter(flag);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    dir: valueAfter('--dir'),
    out: valueAfter('--out'),
    filter: valueAfter('--filter'),
    model: valueAfter('--model') ?? 'google/gemini-3.5-flash',
    frames: num('--frames', 6),
    limit: argv.includes('--limit') ? num('--limit', 0) || null : null,
    motionOnly: argv.includes('--motion-only'),
    concurrency: num('--concurrency', 4),
  };
}

/** One sample video on disk to evaluate. */
type VideoJob = {
  slug: string;
  kind: 'canonical' | 'bespoke';
  videoPath: string;
  styleName: string;
  config: {
    mood: string;
    artStyle: string;
    lighting: string;
    cameraWork: string;
    colorGrading: string;
  } | null;
  brief: string | null;
};

const styleBySlug = new Map(
  DEFAULT_STYLE_TEMPLATES.map((s) => [styleSlug(s.name), s])
);

async function discoverJobs(flags: Flags): Promise<VideoJob[]> {
  const jobs: VideoJob[] = [];
  for (const style of DEFAULT_STYLE_TEMPLATES) {
    const slug = styleSlug(style.name);
    if (flags.filter && flags.filter !== slug && flags.filter !== style.name) {
      continue;
    }
    for (const kind of ['canonical', 'bespoke'] as const) {
      const videoPath = path.join(OUTPUT_DIR, slug, `${kind}.mp4`);
      if (!existsSync(videoPath)) continue;
      const briefPath = path.join(OUTPUT_DIR, slug, `${kind}.enhanced.txt`);
      const brief = existsSync(briefPath)
        ? await readFile(briefPath, 'utf-8')
        : null;
      jobs.push({
        slug,
        kind,
        videoPath,
        styleName: style.name,
        config: (() => {
          const cfg = styleBySlug.get(slug)?.config;
          return cfg
            ? {
                mood: cfg.look.mood,
                artStyle: cfg.look.artStyle,
                lighting: cfg.look.lighting,
                cameraWork: cfg.motion.camera,
                colorGrading: cfg.look.colorGrading,
              }
            : null;
        })(),
        brief: brief?.slice(0, 1500) ?? null,
      });
    }
  }
  return flags.limit ? jobs.slice(0, flags.limit) : jobs;
}

async function probeDurationSeconds(videoPath: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const d = Number(stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : 5;
}

/**
 * Mean luma of the frame-to-frame difference (0–255). Decode at 4fps / 128px
 * grey, difference consecutive frames, average the per-frame YAVG. ~0 = static,
 * higher = more motion. A cheap proxy that needs no model.
 */
async function motionScore(videoPath: string): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), 'motion-'));
  const metaFile = path.join(dir, 'meta.txt');
  try {
    await run('ffmpeg', [
      '-i',
      videoPath,
      '-vf',
      `fps=4,scale=128:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${metaFile}`,
      '-f',
      'null',
      '-',
      '-y',
    ]);
    const txt = await readFile(metaFile, 'utf-8');
    const vals = [...txt.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
    if (vals.length === 0) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  } catch {
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Extract N evenly-spaced frames as scaled JPEGs; returns base64 strings. */
async function sampleFrames(
  videoPath: string,
  count: number,
  tmp: string
): Promise<string[]> {
  const duration = await probeDurationSeconds(videoPath);
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (duration * (i + 0.5)) / count;
    const out = path.join(tmp, `frame_${i}.jpg`);
    await run('ffmpeg', [
      '-ss',
      t.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-1',
      '-q:v',
      '3',
      '-y',
      out,
    ]);
    if (existsSync(out)) frames.push((await readFile(out)).toString('base64'));
  }
  return frames;
}

const verdictSchema = z.object({
  styleAdherence: z.number().min(0).max(10),
  liveliness: z.number().min(0).max(10),
  characterConsistency: z.number().min(0).max(10).nullable(),
  coherence: z.number().min(0).max(10),
  nsfw: z.boolean().default(false),
  violence: z.boolean().default(false),
  overall: z.number().min(0).max(10),
  note: z.string().default(''),
});
type Verdict = z.infer<typeof verdictSchema>;

/** The slice of OpenRouter's chat-completion reply we read. */
const openRouterReplySchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullish() }).nullish(),
    })
  ),
});

const SYSTEM_PROMPT = `You are a strict creative director reviewing frames sampled in time order from ONE short AI-generated style-sample video. The frames are sequential (earliest first), so judge motion/continuity across them, not just a single image.

Return ONLY a JSON object (no markdown):
{ "styleAdherence":0-10, "liveliness":0-10, "characterConsistency":0-10|null, "coherence":0-10, "nsfw":true|false, "violence":true|false, "overall":0-10, "note":"<=200 chars" }

- styleAdherence: how well the look matches the intended art style / mood / lighting / camera / color grading.
- liveliness: is something actually HAPPENING across the frames (action, an event, real motion)? A static/contemplative clip where little changes scores low. Use the provided motion metric as corroboration, but trust the frames.
- characterConsistency: if a person recurs across frames, do their face / hair / wardrobe stay the SAME identity? 10 = identical, 0 = a different person each cut. Set null only if there is no recurring person.
- coherence: freedom from artifacts — morphing, warping, extra/melting limbs, duplicated faces, garbled text/logos.
- nsfw / violence: flag clearly unsafe content.
- overall: holistic quality of this as a polished style sample.
- note: the single most important issue, terse.

Be strict but fair.`;

async function scoreVideo(
  job: VideoJob,
  frames: string[],
  motion: number,
  model: string
): Promise<Verdict> {
  const look = job.config
    ? [
        `Art style: ${job.config.artStyle}`,
        `Mood: ${job.config.mood}`,
        `Lighting: ${job.config.lighting}`,
        `Camera: ${job.config.cameraWork}`,
        `Color grading: ${job.config.colorGrading}`,
      ].join('\n')
    : '(style config unavailable)';

  const userText = [
    `STYLE: ${job.styleName} (${job.kind})`,
    '',
    'Intended look:',
    look,
    '',
    job.brief ? `Brief/script the video was made from:\n${job.brief}` : '',
    '',
    `Computed motion metric (mean frame-diff luma, 0=static … ~20+ = lively): ${motion.toFixed(1)}`,
    `${frames.length} frames follow in time order. Score the video.`,
  ].join('\n');

  const content = [
    { type: 'text', text: userText },
    ...frames.map((b64) => ({
      type: 'image_url' as const,
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    })),
  ];

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://openstory.so',
      'X-Title': 'OpenStory sample-video eval',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      // Headroom for thinking models (gemini-3.5-flash spends reasoning tokens
      // before the JSON) — the verdict itself is tiny.
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  }
  const body = openRouterReplySchema.parse(await res.json());
  const text = body.choices[0]?.message?.content ?? '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON in model reply: ${text.slice(0, 200)}`);
  }
  return verdictSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

type Result = {
  slug: string;
  kind: string;
  motion: number;
  verdict: Verdict | null;
  error?: string;
};

async function evalJob(job: VideoJob, flags: Flags): Promise<Result> {
  const motion = await motionScore(job.videoPath);
  if (flags.motionOnly) {
    return { slug: job.slug, kind: job.kind, motion, verdict: null };
  }
  const tmp = await mkdtemp(path.join(tmpdir(), `eval-${job.slug}-`));
  try {
    const frames = await sampleFrames(job.videoPath, flags.frames, tmp);
    if (frames.length === 0) throw new Error('no frames extracted');
    const verdict = await scoreVideo(job, frames, motion, flags.model);
    return { slug: job.slug, kind: job.kind, motion, verdict };
  } catch (error) {
    return {
      slug: job.slug,
      kind: job.kind,
      motion,
      verdict: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Bounded-concurrency map. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

function fmtRow(r: Result): string {
  const id = `${r.slug}/${r.kind}`.padEnd(38);
  if (r.error)
    return `  ⚠️  ${id} motion ${r.motion.toFixed(1).padStart(5)}  — ${r.error}`;
  const v = r.verdict;
  if (!v) return `      ${id} motion ${r.motion.toFixed(1).padStart(5)}`;
  const cc =
    v.characterConsistency === null
      ? ' n/a'
      : v.characterConsistency.toFixed(0).padStart(4);
  const flags = [v.nsfw && 'NSFW', v.violence && 'VIOLENCE']
    .filter(Boolean)
    .join(',');
  return (
    `  ${v.overall.toFixed(0).padStart(2)}/10 ${id}` +
    ` style ${v.styleAdherence.toFixed(0)} live ${v.liveliness.toFixed(0)} char${cc} coh ${v.coherence.toFixed(0)}` +
    ` motion ${r.motion.toFixed(1).padStart(5)}` +
    (flags ? `  [${flags}]` : '') +
    (v.note ? `  — ${v.note}` : '')
  );
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.dir) OUTPUT_DIR = path.resolve(process.cwd(), flags.dir);
  if (!existsSync(OUTPUT_DIR)) {
    console.error(
      `No ${path.relative(process.cwd(), OUTPUT_DIR)}/ — render samples first.`
    );
    process.exit(1);
  }
  if (!flags.motionOnly && !OPENROUTER_KEY) {
    console.error(
      'OPENROUTER_KEY not set — run with --motion-only, or set the key for the rubric.'
    );
    process.exit(1);
  }

  const jobs = await discoverJobs(flags);
  if (jobs.length === 0) {
    console.error('No matching sample videos found.');
    process.exit(1);
  }
  console.log(
    `🎬 Evaluating ${jobs.length} video(s)` +
      (flags.motionOnly ? ' (motion only)' : ` via ${flags.model}`) +
      `…\n`
  );

  let done = 0;
  const results = await pool(jobs, flags.concurrency, async (job) => {
    const r = await evalJob(job, flags);
    done++;
    console.log(`[${done}/${jobs.length}]${fmtRow(r)}`);
    return r;
  });

  // Sorted worst-first summary (errors, then lowest overall, then lowest motion).
  const ranked = [...results].sort((a, b) => {
    if (a.error && !b.error) return -1;
    if (b.error && !a.error) return 1;
    const ao = a.verdict?.overall ?? -1;
    const bo = b.verdict?.overall ?? -1;
    if (ao !== bo) return ao - bo;
    return a.motion - b.motion;
  });

  console.log('\n=== worst first ===');
  for (const r of ranked) console.log(fmtRow(r));

  const verdicts = results
    .map((r) => r.verdict)
    .filter((v): v is Verdict => v !== null);
  if (verdicts.length > 0) {
    const avg = (sel: (v: Verdict) => number) =>
      (verdicts.reduce((s, v) => s + sel(v), 0) / verdicts.length).toFixed(1);
    console.log(
      `\nAverages — overall ${avg((v) => v.overall)}, style ${avg((v) => v.styleAdherence)}, ` +
        `liveliness ${avg((v) => v.liveliness)}, coherence ${avg((v) => v.coherence)}`
    );
  }
  const errored = results.filter((r) => r.error).length;
  if (errored) console.log(`${errored} eval error(s).`);

  // `--out` lets a judge write its own file (e.g. eval-scores-grok.json) so
  // re-scoring the same set with multiple models doesn't clobber.
  const outPath = flags.out
    ? path.resolve(process.cwd(), flags.out)
    : path.join(OUTPUT_DIR, 'eval-scores.json');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify({ model: flags.model, results: ranked }, null, 2)
  );
  console.log(`\n📄 ${path.relative(process.cwd(), outPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
