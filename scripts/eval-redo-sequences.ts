/**
 * Eval harness for the image-only "redo" sequences (issue #801).
 *
 * Unlike `eval-style-sample-videos.ts` (which judges rendered .mp4 clips), this
 * evaluates sequences that were submitted with `--no-motion` and live on prod:
 * it judges the ENHANCED SCRIPT, the per-frame VISUAL + MOTION prompts, and the
 * generated STILL IMAGES together, against the style's intended look + brief.
 *
 * Input: `/tmp/prod-eval-data.json` — the consolidated prod pull
 * (slug, id, style title, enhanced script, frames[{order, sceneTitle,
 * visualPrompt, motionPrompt, imageUrl}]). Image URLs are origin-relative
 * (`/r2/…`); we prefix `OPENSTORY_API_URL` (default https://openstory.so),
 * download, and send as base64 to a vision model via OpenRouter.
 *
 *   OPENROUTER_KEY=… bun --env-file=.env.admin scripts/eval-redo-sequences.ts
 *     [--in /tmp/prod-eval-data.json] [--out /tmp/redo-eval.json]
 *     [--model google/gemini-3.5-flash] [--filter perfume-editorial,rom-com]
 *     [--limit 5] [--concurrency 4]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { briefForStyle } from '@/lib/style/sample-videos';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { z } from 'zod';

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ORIGIN = process.env.OPENSTORY_API_URL ?? 'https://openstory.so';

const frameSchema = z.object({
  order: z.number(),
  sceneTitle: z.string().nullable(),
  visualPrompt: z.string().nullable(),
  motionPrompt: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
const dataSchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    style: z.string(),
    status: z.string().optional(),
    script: z.string().nullable(),
    frames: z.array(frameSchema),
  })
);
type SeqData = z.infer<typeof dataSchema>[number];

type Flags = {
  in: string;
  out: string;
  model: string;
  filter: string[] | null;
  limit: number | null;
  concurrency: number;
};

function parseFlags(argv: string[]): Flags {
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 ? (argv[i + 1]?.trim() ?? null) : null;
  };
  const filterRaw = val('--filter');
  const limitRaw = val('--limit');
  return {
    in: val('--in') ?? '/tmp/prod-eval-data.json',
    out: val('--out') ?? '/tmp/redo-eval.json',
    model: val('--model') ?? 'google/gemini-3.5-flash',
    filter: filterRaw
      ? filterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    limit:
      limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : null,
    concurrency: Number(val('--concurrency') ?? '4') || 4,
  };
}

const verdictSchema = z.object({
  scriptQuality: z.number().min(0).max(10),
  styleAdherence: z.number().min(0).max(10),
  promptImageMatch: z.number().min(0).max(10),
  startingFrame: z.number().min(0).max(10),
  characterConsistency: z.number().min(0).max(10).nullable(),
  coherence: z.number().min(0).max(10),
  nsfw: z.boolean().default(false),
  violence: z.boolean().default(false),
  contentRisk: z.boolean().default(false),
  overall: z.number().min(0).max(10),
  // Free-form: models phrase this loosely ("Keep", "redo — reseed scene 2",
  // "reshoot hero"). The keep/redo decision is derived downstream (decide()).
  recommendation: z.string().default(''),
  note: z.string().default(''),
});
type Verdict = z.infer<typeof verdictSchema>;

/** Keep/redo decision: trust the model's word if present, else the score. */
function decide(v: Verdict): 'keep' | 'redo' {
  const s = v.recommendation.toLowerCase();
  if (s.includes('redo')) return 'redo';
  if (s.includes('keep')) return 'keep';
  return v.overall >= 7 ? 'keep' : 'redo';
}

const openRouterReplySchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string().nullish() }).nullish() })
  ),
});

const SYSTEM_PROMPT = `You are a strict creative director reviewing ONE short AI-generated style-sample sequence that was rendered as STILL IMAGES ONLY (no motion yet). You receive, in scene order: the style's intended look, the brief it was made from, the platform-enhanced script, and for each scene a VISUAL prompt, a MOTION prompt, and the generated still image (images attached in order).

Each still is meant to be the STARTING FRAME of its shot — the beginning of the action, with room to move into the motion described — not the peak or middle.

Return ONLY a JSON object (no markdown):
{ "scriptQuality":0-10, "styleAdherence":0-10, "promptImageMatch":0-10, "startingFrame":0-10, "characterConsistency":0-10|null, "coherence":0-10, "nsfw":bool, "violence":bool, "contentRisk":bool, "overall":0-10, "recommendation":"keep"|"redo", "note":"<=240 chars" }

- scriptQuality: does the enhanced script fit the style + brief, read coherently, and stay on the right register for this genre?
- styleAdherence: do the images match the intended art style / mood / lighting / camera / color grading?
- promptImageMatch: does each still faithfully render ITS visual prompt (subject, composition, elements)?
- startingFrame: is each still a good START of the action (potential energy, room for the motion prompt to unfold), not a mid/peak moment?
- characterConsistency: if a person recurs across scenes, is it the SAME identity (face/hair/wardrobe)? 10=identical, 0=different person each cut. null if no recurring person.
- coherence: freedom from artifacts — morphing, warped/melting/extra limbs, duplicated faces, garbled text/logos.
- nsfw/violence: flag clearly unsafe content. contentRisk: borderline content likely to trip a generation content filter even if not strictly unsafe.
- overall: holistic quality as a polished style sample.
- recommendation: "keep" if this is a good sample, "redo" if it needs regenerating.
- note: the single most important issue, terse.

Be strict but fair.`;

const styleBySlug = new Map(
  DEFAULT_STYLE_TEMPLATES.map((s) => [styleSlug(s.name), s])
);

function intendedLook(slug: string): string {
  // Allow a `slug:variant` form (e.g. an A/B over image models) — resolve the
  // style template from the base slug before the colon.
  const baseSlug = slug.split(':')[0] ?? slug;
  const s = styleBySlug.get(baseSlug);
  if (!s) return '(style template not found)';
  const c = s.config;
  return [
    `Style: ${s.name} (${s.category ?? 'n/a'})`,
    s.description ? `Description: ${s.description}` : '',
    `Mood: ${c.look.mood}`,
    `Art style: ${c.look.artStyle}`,
    `Lighting: ${c.look.lighting}`,
    `Camera: ${c.motion.camera}`,
    `Color grading: ${c.look.colorGrading}`,
    `Brief: ${briefForStyle({ name: s.name, category: s.category ?? null })}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Fetch a frame image as base64, downscaled via Cloudflare image resizing.
 * The raw R2 thumbnails are ~5MB webp — over common vision-API per-image
 * limits — so we route through `/cdn-cgi/image/...` to get a ~200KB JPEG.
 * Origin-relative `/r2/…` URLs are prefixed with ORIGIN. Returns null on a
 * failed fetch (logged), so a dropped frame is visible rather than silently
 * collapsing into a partial-sequence eval.
 */
async function fetchImageB64(relUrl: string): Promise<string | null> {
  const path = relUrl.startsWith('http') ? new URL(relUrl).pathname : relUrl;
  const url = `${ORIGIN}/cdn-cgi/image/width=1280,quality=82,format=jpeg${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`   ⚠️  image fetch failed (${res.status}): ${url}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

type Result = {
  slug: string;
  style: string;
  verdict: Verdict | null;
  error?: string;
};

async function evalSequence(seq: SeqData, model: string): Promise<Result> {
  try {
    const ordered = [...seq.frames].sort((a, b) => a.order - b.order);
    const images = await Promise.all(
      ordered.map((f) =>
        f.imageUrl ? fetchImageB64(f.imageUrl) : Promise.resolve(null)
      )
    );
    const gotImages = images.filter((b): b is string => b !== null);
    if (gotImages.length === 0) throw new Error('no images fetched');

    const sceneText = ordered
      .map((f, i) =>
        [
          `SCENE ${i + 1}: ${f.sceneTitle ?? '(untitled)'}`,
          `  visual: ${f.visualPrompt ?? '(none)'}`,
          `  motion: ${f.motionPrompt ?? '(none)'}`,
        ].join('\n')
      )
      .join('\n\n');

    const userText = [
      `STYLE SAMPLE: ${seq.slug}`,
      '',
      'INTENDED LOOK:',
      intendedLook(seq.slug),
      '',
      'ENHANCED SCRIPT:',
      seq.script ?? '(none)',
      '',
      'PER-SCENE PROMPTS:',
      sceneText,
      '',
      `${gotImages.length} still image(s) follow in scene order. Evaluate the script, prompts, and images.`,
    ].join('\n');

    const content = [
      { type: 'text', text: userText },
      ...gotImages.map((b64) => ({
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
        'X-Title': 'OpenStory redo-sequence eval',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
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
      throw new Error(`No JSON in reply: ${text.slice(0, 200)}`);
    }
    const verdict = verdictSchema.parse(JSON.parse(text.slice(start, end + 1)));
    return { slug: seq.slug, style: seq.style, verdict };
  } catch (error) {
    return {
      slug: seq.slug,
      style: seq.style,
      verdict: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
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

async function main(): Promise<void> {
  if (!OPENROUTER_KEY) {
    console.error('Set OPENROUTER_KEY (e.g. bun --env-file=.env.admin …).');
    process.exit(1);
  }
  const flags = parseFlags(process.argv.slice(2));
  const all = dataSchema.parse(JSON.parse(await readFile(flags.in, 'utf-8')));
  let seqs = flags.filter
    ? all.filter((s) => flags.filter?.includes(s.slug))
    : all;
  if (flags.limit !== null) seqs = seqs.slice(0, flags.limit);
  if (seqs.length === 0) {
    console.error('No sequences matched.');
    process.exit(1);
  }

  console.log(
    `🔍 Evaluating ${seqs.length} sequence(s) with ${flags.model} (script + prompts + images)\n`
  );
  const results = await pool(seqs, flags.concurrency, (s) =>
    evalSequence(s, flags.model)
  );

  await writeFile(flags.out, JSON.stringify(results, null, 2));

  const scored = results.filter((r) => r.verdict);
  scored.sort((a, b) => (a.verdict?.overall ?? 0) - (b.verdict?.overall ?? 0));
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(pad('slug', 22) + ' over scr sty p→i strt char coh  rec   note');
  for (const r of scored) {
    const v = r.verdict;
    if (!v) continue;
    const flags2 = [
      v.nsfw && 'NSFW',
      v.violence && 'VIOL',
      v.contentRisk && 'risk',
    ]
      .filter(Boolean)
      .join(',');
    console.log(
      pad(r.slug, 22) +
        ` ${String(v.overall).padStart(4)} ${String(v.scriptQuality).padStart(3)} ${String(v.styleAdherence).padStart(3)} ${String(v.promptImageMatch).padStart(3)} ${String(v.startingFrame).padStart(4)} ${String(v.characterConsistency ?? '-').padStart(4)} ${String(v.coherence).padStart(3)}  ${pad(decide(v), 4)} ${flags2 ? `[${flags2}] ` : ''}${v.note}`
    );
  }
  const errored = results.filter((r) => r.error);
  if (errored.length) {
    console.log(`\n${errored.length} errored:`);
    for (const r of errored) console.log(`  ${r.slug}: ${r.error}`);
  }
  console.log(`\nWrote ${flags.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
