#!/usr/bin/env bun
/**
 * Score style preview thumbnails with a vision LLM (issue #718).
 *
 * COMPARATIVE scoring: all of a style's candidate scenes (preview/{slug}/*.webp)
 * are sent in ONE vision call so the model ranks them against each other and
 * picks the one that best SHOWCASES the style — far more discriminating than
 * scoring each image in isolation (which over-rewarded generic portraits). It
 * also flags the failure modes we hit by hand: literal-medium renders (a book,
 * a storyboard sheet), multi-frame/panel grids, malformed anatomy, stray text.
 *
 * Outputs (report-only — never deletes anything):
 *   preview/_scores.json       full per-scene verdicts
 *   preview/_thumbnails.json    { slug: bestScene } — the model's pick per style
 *                               (feed to upload-style-previews-to-r2.ts via
 *                               --thumbnail-map)
 *   console: styles ranked worst-first + a re-roll list (below --threshold or a
 *            hard flag on the chosen scene). Exits non-zero if any style fails.
 *
 * Note: LLM anatomy detection is imperfect — treat anatomy flags as a strong
 * hint, not gospel; spot-check the chosen thumbnails.
 *
 * Usage:
 *   bun scripts/score-style-previews.ts                       # score all
 *   bun scripts/score-style-previews.ts --filter "Pop-Up Book"
 *   bun scripts/score-style-previews.ts --scene action        # only that scene
 *   bun scripts/score-style-previews.ts --model openai/gpt-5.5 --threshold 6.5
 */
import { parseStyleConfig } from '@/lib/style/style-config';
import type { TextModel } from '@/lib/ai/models';
import { callLLM } from '@/lib/ai/llm-client';
import {
  ANALYSIS_MODEL_IDS,
  isValidAnalysisModelId,
} from '@/lib/ai/models.config';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import type { ChatMessage, ChatMessageContentPart } from '@/lib/prompts';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { PhotonImage } from '@cf-wasm/photon';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const PREVIEW_DIR = path.join(process.cwd(), 'preview');
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

function parseArg(name: string): string | undefined {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function resolveModel(): TextModel {
  const m = parseArg('model') ?? DEFAULT_MODEL;
  if (!isValidAnalysisModelId(m)) {
    console.error(
      `Invalid --model "${m}". Options:\n  ${ANALYSIS_MODEL_IDS.join('\n  ')}`
    );
    process.exit(1);
  }
  return m;
}

const MODEL = resolveModel();
const FILTER = parseArg('filter') ?? null;
const SCENE = parseArg('scene') ?? null; // e.g. --scene action (only that scene)
const THRESHOLD = Number(parseArg('threshold') ?? '6');
const CONCURRENCY = Number(parseArg('concurrency') ?? '6');
const openRouterKey = process.env.OPENROUTER_KEY;
if (!openRouterKey) {
  console.error('OPENROUTER_KEY is required to score previews.');
  process.exit(1);
}

const sceneVerdictSchema = z.object({
  name: z.string(),
  styleAdherence: z.number().min(0).max(10),
  representativeness: z.number().min(0).max(10),
  quality: z.number().min(0).max(10),
  // Flags default to false when the model omits them (a missing flag = not set).
  literalMedium: z.boolean().default(false),
  multiFrame: z.boolean().default(false),
  anatomy: z.boolean().default(false),
  unwantedText: z.boolean().default(false),
  note: z.string().default(''),
});
type SceneVerdict = z.infer<typeof sceneVerdictSchema>;

const styleVerdictSchema = z.object({
  scenes: z.array(sceneVerdictSchema).min(1),
  best: z.string(),
});

const SYSTEM_PROMPT = `You are a strict art director choosing the single best STYLE PREVIEW thumbnail for a video-style picker. You are shown the candidate scenes for ONE style (in the order listed) plus the style's intended look. Compare them against each other.

Return ONLY a JSON object (no markdown, no prose):
{ "scenes": [ { "name": "<scene>", "styleAdherence": 0-10, "representativeness": 0-10, "quality": 0-10, "literalMedium": true|false, "multiFrame": true|false, "anatomy": true|false, "unwantedText": true|false, "note": "<=160 chars" } ], "best": "<scene name>" }

Score EACH scene, then choose "best" — the one image that should represent this style as its thumbnail.

Definitions:
- styleAdherence: how well the look matches the intended artStyle/mood/lighting/camera/colorGrading.
- representativeness: COMPARED TO THE OTHER SCENES SHOWN, how well does this image convey what makes THIS style distinctive and what it's for? A generic close-up portrait should score LOWER than a scene that captures the style's signature look — unless the style is genuinely about faces/people. The most representative scene wins.
- quality: clear subject, well composed, in focus, appealing at small thumbnail size.
- literalMedium (hard fail): depicts the MEDIUM/FORMAT/ARTIFACT as the object — a physical book, storyboard sheet, panel sheet, a TV/monitor/phone showing the scene — instead of a scene in that style. If the intended look IS a device/setup (phone in-hand, product on white, turntable, UI, stage), that's CORRECT — set false.
- multiFrame (hard fail): a grid, multiple panels, collage, split-screen, or several separate images in one frame.
- anatomy (hard fail): set true ONLY for a clear, obvious anatomy error a viewer would notice at a glance — an extra / missing / duplicated / floating hand or limb, an obviously wrong finger count on a prominent hand, or a badly distorted face. Do NOT flag minor or soft imperfections, slightly messy or blurred small/background hands, or stylized hands that read as acceptable for the style. If you'd call it "acceptable", set false. When in doubt, set false.
- unwantedText: any text, caption, watermark, logo, or frame number.

"best" MUST be one of the scene names, and MUST NOT be a scene you flagged literalMedium/multiFrame/anatomy unless every scene is flagged. Be strict and consistent.`;

function introText(name: string, c: StyleConfig, sceneOrder: string[]): string {
  return [
    `STYLE: ${name}`,
    '',
    'Intended look:',
    `- Art style: ${c.look.artStyle}`,
    `- Mood: ${c.look.mood}`,
    `- Lighting: ${c.look.lighting}`,
    `- Camera: ${c.motion.camera}`,
    `- Color grading: ${c.look.colorGrading}`,
    '',
    `The ${sceneOrder.length} candidate scene image(s) follow, in this order: ${sceneOrder
      .map((s, i) => `${i + 1}) ${s}`)
      .join(', ')}.`,
    'Score each and pick the best thumbnail.',
  ].join('\n');
}

/** Decode a webp file and return a base64 JPEG for the vision payload. */
async function toJpegBase64(filePath: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(filePath));
  const image = PhotonImage.new_from_byteslice(bytes);
  try {
    return Buffer.from(image.get_bytes_jpeg(85)).toString('base64');
  } finally {
    image.free();
  }
}

/** Extract the JSON object from an LLM reply, tolerating ```json fences / prose. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Scorer returned no JSON object');
  }
  return candidate.slice(start, end + 1);
}

// HARD flags gate the pick + reroll: literal-medium and multi-frame, which the
// model detects reliably. Anatomy is a SOFT signal — gemini-flash can't be
// tuned to flag it dependably (over-flags messy action shots, under-flags real
// errors), so it only nudges the score down and is surfaced for human review.
function hardFlagCount(v: SceneVerdict): number {
  return [v.literalMedium, v.multiFrame].filter(Boolean).length;
}
function composite(v: SceneVerdict): number {
  const mean = (v.styleAdherence + v.representativeness + v.quality) / 3;
  const penalty = 3 * hardFlagCount(v) + (v.anatomy ? 1.5 : 0);
  return Math.max(0, Math.round((mean - penalty) * 10) / 10);
}
function flagLabels(v: SceneVerdict): string {
  const f: string[] = [];
  if (v.literalMedium) f.push('LITERAL');
  if (v.multiFrame) f.push('MULTIFRAME');
  if (v.anatomy) f.push('ANATOMY');
  if (v.unwantedText) f.push('text');
  return f.join(',');
}

type SceneInput = { scene: string; file: string };
type SceneResult = { scene: string; verdict: SceneVerdict; composite: number };
type StyleResult = {
  name: string;
  slug: string;
  scenes: SceneResult[];
  bestScene: string;
  bestComposite: number;
};

/** Score all of a style's scenes in one comparative call; returns per-scene
 *  results + the model's chosen best scene (validated, with a safe fallback). */
async function scoreStyle(
  name: string,
  config: StyleConfig,
  inputs: SceneInput[]
): Promise<{ scenes: SceneResult[]; bestScene: string }> {
  const order = inputs.map((i) => i.scene);
  const imageParts = await Promise.all(
    inputs.map(async (i): Promise<ChatMessageContentPart> => {
      const value = await toJpegBase64(i.file);
      return {
        type: 'image',
        source: { type: 'data', value, mimeType: 'image/jpeg' },
      };
    })
  );
  const content: ChatMessageContentPart[] = [
    { type: 'text', content: introText(name, config, order) },
    ...imageParts,
  ];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ];
  const reply = await callLLM({
    model: MODEL,
    messages,
    max_tokens: 1200,
    temperature: 0,
    observationName: 'score-style-preview',
    apiKey: { key: openRouterKey, via: 'openrouter' },
  });
  const parsed = styleVerdictSchema.parse(JSON.parse(extractJson(reply)));

  // Map the model's per-scene verdicts onto the scenes we actually sent.
  const byName = new Map(
    parsed.scenes.map((v) => [v.name.toLowerCase().trim(), v])
  );
  const scenes: SceneResult[] = inputs.map((i) => {
    const verdict = byName.get(i.scene.toLowerCase());
    if (!verdict) throw new Error(`No verdict returned for scene "${i.scene}"`);
    return { scene: i.scene, verdict, composite: composite(verdict) };
  });

  // Honor the model's pick if valid and not hard-flagged; else fall back to the
  // best un-flagged / most-representative / highest-composite scene.
  const picked = scenes.find(
    (s) => s.scene.toLowerCase() === parsed.best.toLowerCase()
  );
  const bestScene =
    picked && hardFlagCount(picked.verdict) === 0
      ? picked.scene
      : ([...scenes].sort((a, b) => {
          const fa = hardFlagCount(a.verdict) === 0 ? 1 : 0;
          const fb = hardFlagCount(b.verdict) === 0 ? 1 : 0;
          if (fa !== fb) return fb - fa;
          if (a.verdict.representativeness !== b.verdict.representativeness)
            return b.verdict.representativeness - a.verdict.representativeness;
          return b.composite - a.composite;
        })[0]?.scene ??
        scenes[0]?.scene ??
        order[0] ??
        '');
  return { scenes, bestScene };
}

async function main() {
  const bySlug = new Map(
    DEFAULT_STYLE_TEMPLATES.map((s) => [styleSlug(s.name), s])
  );

  // Group preview images on disk by style.
  const dirs = (await readdir(PREVIEW_DIR, { withFileTypes: true })).filter(
    (d) => d.isDirectory()
  );
  type StyleTask = {
    name: string;
    slug: string;
    config: StyleConfig;
    inputs: SceneInput[];
  };
  const styleTasks: StyleTask[] = [];
  for (const dir of dirs) {
    const slug = dir.name;
    const style = bySlug.get(slug);
    if (!style) continue; // skip non-style dirs (talent/locations/etc.)
    if (FILTER && FILTER !== style.name && FILTER !== slug) continue;
    const inputs: SceneInput[] = [];
    for (const file of await readdir(path.join(PREVIEW_DIR, slug))) {
      if (path.extname(file).toLowerCase() !== '.webp') continue;
      const scene = path.basename(file, '.webp');
      if (SCENE && scene !== SCENE) continue;
      inputs.push({ scene, file: path.join(PREVIEW_DIR, slug, file) });
    }
    if (inputs.length > 0) {
      styleTasks.push({
        name: style.name,
        slug,
        config: parseStyleConfig(style.config),
        inputs,
      });
    }
  }

  if (styleTasks.length === 0) {
    console.error(
      'No preview images found. Run generate-style-previews.ts first.'
    );
    process.exit(1);
  }
  const totalImages = styleTasks.reduce((n, t) => n + t.inputs.length, 0);
  console.log(
    `Scoring ${styleTasks.length} styles (${totalImages} images) with ${MODEL} (concurrency ${CONCURRENCY})…\n`
  );

  // Concurrency-limited scoring, one call per style.
  const results: StyleResult[] = [];
  const failures: string[] = [];
  let index = 0;
  let done = 0;
  const worker = async () => {
    while (index < styleTasks.length) {
      const t = styleTasks[index++];
      if (!t) break;
      try {
        const { scenes, bestScene } = await scoreStyle(
          t.name,
          t.config,
          t.inputs
        );
        const best = scenes.find((s) => s.scene === bestScene);
        results.push({
          name: t.name,
          slug: t.slug,
          scenes,
          bestScene,
          bestComposite: best?.composite ?? 0,
        });
      } catch (error) {
        failures.push(
          `${t.slug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      done++;
      if (done % 5 === 0 || done === styleTasks.length) {
        process.stderr.write(`  scored ${done}/${styleTasks.length} styles\n`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, styleTasks.length) }, worker)
  );

  results.sort((a, b) => a.bestComposite - b.bestComposite);

  // Write artifacts.
  await writeFile(
    path.join(PREVIEW_DIR, '_scores.json'),
    JSON.stringify({ model: MODEL, threshold: THRESHOLD, results }, null, 2)
  );
  const thumbnailMap = Object.fromEntries(
    results.map((r) => [r.slug, r.bestScene])
  );
  await writeFile(
    path.join(PREVIEW_DIR, '_thumbnails.json'),
    JSON.stringify(thumbnailMap, null, 2)
  );

  // Console report — worst first.
  console.log('\nStyle scores (worst first) — chosen-scene composite /10:\n');
  for (const r of results) {
    const best = r.scenes.find((s) => s.scene === r.bestScene)?.verdict;
    const flags = best ? flagLabels(best) : '';
    console.log(
      `  ${r.bestComposite.toFixed(1).padStart(4)}  ${r.slug.padEnd(28)} best=${r.bestScene.padEnd(12)} ${flags}`
    );
  }

  // Re-roll = a hard failure (literal-medium / multi-frame) on the chosen scene,
  // or a composite below threshold.
  const chosenVerdict = (r: StyleResult) =>
    r.scenes.find((s) => s.scene === r.bestScene)?.verdict;
  const reroll = results.filter((r) => {
    const best = chosenVerdict(r);
    return (
      r.bestComposite < THRESHOLD || (best ? hardFlagCount(best) > 0 : true)
    );
  });
  console.log(
    `\n${results.length} styles scored. ${reroll.length} below threshold ${THRESHOLD} or hard-flagged on chosen scene:`
  );
  for (const r of reroll)
    console.log(`  - ${r.slug} (${r.bestComposite.toFixed(1)})`);

  // Soft advisory: chosen thumbnails the model flagged for anatomy — worth a
  // human spot-check (the flag is unreliable, so it's not auto-rerolled).
  const anatomyReview = results.filter((r) => chosenVerdict(r)?.anatomy);
  console.log(
    `\n${anatomyReview.length} chosen thumbnail(s) flagged for anatomy — spot-check:`
  );
  for (const r of anatomyReview) console.log(`  ? ${r.slug} (${r.bestScene})`);
  console.log(`\nWrote preview/_scores.json and preview/_thumbnails.json`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} styles failed to score:`);
    for (const f of failures) console.error(`  - ${f}`);
  }
  if (reroll.length > 0 || failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
