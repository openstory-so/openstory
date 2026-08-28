/**
 * Generate a per-style sample brief from each style's OWN self-description,
 * not a coarse `category` bucket.
 *
 * The bug this fixes: `CATEGORY_BRIEFS` maps ~80 styles onto ~17 category
 * briefs, so any style that isn't the "representative" one for its bucket gets
 * a brief that fights its own look — e.g. the talking-head "Car Talk" style
 * inherited the influencer "unbox a product and fumble it" brief and rendered a
 * guy driving while juggling a mug. Every style template already describes
 * itself accurately (description + config); this reads that and asks an LLM for
 * one shootable, on-style brief per style.
 *
 * Preview (prints, writes nothing):
 *   OPENROUTER_KEY=… bun --env-file=.env.admin scripts/generate-style-briefs.ts --category influencer
 *   …--filter "car-talk,podcast-clip" | --limit 10 | --model anthropic/claude-opus-5
 *
 * Commit (writes a generated Record<slug,brief> TS module):
 *   …scripts/generate-style-briefs.ts --out src/lib/style/style-briefs.generated.ts
 *
 * Script-only (not imported by the app). Uses OpenRouter's REST endpoint
 * directly, like the eval harness — no worker-env dependency.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { styleSlug } from '@/lib/style/style-slug';
import { z } from 'zod';

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

type Flags = {
  category: string | null;
  filter: string[] | null;
  limit: number | null;
  model: string;
  out: string | null;
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
  const filterRaw = valueAfter('--filter');
  return {
    category: valueAfter('--category'),
    filter: filterRaw
      ? filterRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    limit: argv.includes('--limit') ? num('--limit', 0) || null : null,
    model: valueAfter('--model') ?? 'anthropic/claude-opus-5',
    out: valueAfter('--out'),
    concurrency: num('--concurrency', 4),
  };
}

const SYSTEM_PROMPT = `You write the seed BRIEF for an AI video style-sample. Given ONE video STYLE (its name, what it is for, and its visual config), write a single vivid sentence describing a concrete sample video FOR THAT STYLE. A downstream script-enhancer expands your brief into a ~15-second, 2–3 scene clip, and each scene becomes a motion clip, so the brief must imply real movement.

HARD RULES:
- Match the style's ACTUAL purpose and format. A talking-head / monologue / vlog / interview / podcast style = a person TALKING to camera in that setting (do NOT invent an unrelated prop or action like "unboxes a product"). A product/hero style = the product. A tutorial = the task being demonstrated. A cinematic genre = an event in that genre. Read the description and artStyle and honour them literally.
- Name a concrete SUBJECT and a real EVENT with visible motion — something happens. Never a static mood piece, never a person standing still.
- If a person appears, give them an explicit gender and a short visual descriptor (hair, wardrobe) so their identity stays consistent across cuts.
- Keep it shootable in the style's own setting, lighting and camera (use the config cues).
- Stay safely inside content filters: no nudity, no violence or gore, no lone-woman-in-peril framing. Swimwear is fine where on-brief (e.g. a woman on a beach in a swimsuit).
- One sentence, present tense, ~25–50 words.

Return ONLY JSON: { "brief": "<the sentence>" }`;

const replySchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullish() }).nullish(),
    })
  ),
});
const briefSchema = z.object({ brief: z.string().min(10) });

type StyleEntry = (typeof DEFAULT_STYLE_TEMPLATES)[number];

function styleBlock(style: StyleEntry): string {
  const c = style.config;
  return [
    `Name: ${style.name}`,
    `What it's for: ${style.description}`,
    `Category: ${style.category ?? '—'}`,
    style.tags?.length ? `Tags: ${style.tags.join(', ')}` : '',
    style.useCases?.length ? `Use cases: ${style.useCases.join(', ')}` : '',
    `Mood: ${c.look.mood}`,
    `Art style / staging: ${c.look.artStyle}`,
    `Lighting: ${c.look.lighting}`,
    `Camera: ${c.motion.camera}`,
    `Color grading: ${c.look.colorGrading}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function generateBrief(
  style: StyleEntry,
  model: string
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://openstory.so',
      'X-Title': 'OpenStory style-brief generation',
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: styleBlock(style) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const body = replySchema.parse(await res.json());
  const text = body.choices[0]?.message?.content ?? '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON in reply: ${text.slice(0, 160)}`);
  }
  return briefSchema.parse(JSON.parse(text.slice(start, end + 1))).brief.trim();
}

/** Bounded-concurrency map preserving order. */
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

function selectStyles(flags: Flags): StyleEntry[] {
  let styles = DEFAULT_STYLE_TEMPLATES.filter((s) => {
    if (flags.category && s.category !== flags.category) return false;
    if (flags.filter) {
      const slug = styleSlug(s.name);
      return flags.filter.includes(slug) || flags.filter.includes(s.name);
    }
    return true;
  });
  if (flags.limit) styles = styles.slice(0, flags.limit);
  return styles;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!OPENROUTER_KEY) {
    console.error('OPENROUTER_KEY not set (use --env-file=.env.admin).');
    process.exit(1);
  }
  const styles = selectStyles(flags);
  if (styles.length === 0) {
    console.error('No matching styles. Check --category / --filter.');
    process.exit(1);
  }
  console.log(
    `✍️  Generating ${styles.length} brief(s) via ${flags.model}` +
      (flags.out ? ` → ${flags.out}` : ' (preview — writing nothing)') +
      '…\n'
  );

  const briefs: {
    slug: string;
    name: string;
    brief: string | null;
    error?: string;
  }[] = await pool(styles, flags.concurrency, async (style) => {
    const slug = styleSlug(style.name);
    try {
      const brief = await generateBrief(style, flags.model);
      console.log(`• ${style.name} (${slug})\n    ${brief}\n`);
      return { slug, name: style.name, brief };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️  ${style.name} (${slug}): ${message}\n`);
      return { slug, name: style.name, brief: null, error: message };
    }
  });

  const ok = briefs.filter((b) => b.brief);
  const failed = briefs.length - ok.length;
  console.log(
    `Done: ${ok.length}/${briefs.length} generated${failed ? `, ${failed} failed` : ''}.`
  );

  if (flags.out) {
    const record = Object.fromEntries(ok.map((b) => [b.slug, b.brief]));
    const body =
      '// AUTO-GENERATED by scripts/generate-style-briefs.ts — do not edit by hand.\n' +
      '// One sample brief per style, derived from each style’s own description + config.\n\n' +
      '/**\n' +
      ' * Consumed by `briefForStyle` in `sample-videos.ts` (script/test graph only),\n' +
      " * which knip doesn't trace — keep this `@public` so it isn't flagged as dead.\n" +
      ' * @public\n' +
      ' */\n' +
      `export const GENERATED_STYLE_BRIEFS: Record<string, string> = ${JSON.stringify(record, null, 2)};\n`;
    const outPath = path.resolve(process.cwd(), flags.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, body);
    console.log(
      `📄 ${path.relative(process.cwd(), outPath)} (${ok.length} briefs)`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
