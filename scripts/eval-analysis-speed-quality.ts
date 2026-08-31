#!/usr/bin/env bun
/**
 * Speed vs quality eval for every LLM call in the analysis pipeline.
 *
 * Fairness:
 *   - Same frozen gold inputs for every (model × effort × call)
 *   - Later stages do not consume a candidate's own earlier output
 *   - Production prompts + schemas
 *   - All traffic via OpenRouter (no native xAI)
 *   - Blinded judge never sees the model id
 *
 * Usage:
 *   bun --env-file=.env.local scripts/eval-analysis-speed-quality.ts
 *   bun --env-file=.env.local scripts/eval-analysis-speed-quality.ts --quick
 *   bun --env-file=.env.local scripts/eval-analysis-speed-quality.ts --full
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getChatPrompt } from '@/lib/prompts';
import {
  locationMatchResponseSchema,
  musicDesignResultSchema,
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
  talentMatchResponseSchema,
} from '@/lib/ai/response-schemas';
import {
  motionPromptSchema,
  visualPromptResultSchema,
} from '@/lib/ai/scene-analysis.schema';
import {
  SCRIPT_ANALYSIS_MODELS,
  getAnalysisModelById,
  isSelectableAnalysisModelId,
} from '@/lib/ai/models.config';
import { addLineGutter } from '@/lib/ai/boundary-split';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import { buildMatchingPromptVariables } from '@/lib/ai/talent-matching-prompt';
import { buildLocationMatchingPromptVariables } from '@/lib/ai/location-matching-prompt';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { STYLE_CATEGORIES } from '@/lib/style/auto-style';
import { STYLE_PACE_VALUES } from '@/lib/style/style-config';
import type { LibraryLocation } from '@/lib/db/schema/location-library';
import {
  LOCATION_CASE,
  PROSE_GOLD_BEATS,
  PROSE_SCRIPT,
  TALENT_CASE,
  loadEvalGold,
  type EvalGold,
} from './eval-analysis/fixtures';
import {
  EFFORTS,
  attachVision,
  timedStructuredCall,
  type Effort,
} from './eval-analysis/caller';
import {
  blend,
  gutterLineCount,
  judgeSchema,
  scoreAutoStyle,
  scoreBibles,
  scoreLocation,
  scoreMotion,
  scoreMusic,
  scoreSceneSplit,
  scoreTalent,
  scoreVisual,
} from './eval-analysis/score';
import { writeReport, type EvalRow } from './eval-analysis/report';

const CALLS = [
  'split-screenplay',
  'split-prose',
  'bibles',
  'auto-style',
  'talent',
  'location',
  'visual',
  'motion',
  'music',
] as const;
type CallId = (typeof CALLS)[number];

const SPEED_SWEEP_MODELS = [
  'anthropic/claude-opus-5-fast',
  'google/gemini-3.7-flash',
  'openai/gpt-5.6-luna',
  'z-ai/glm-5.3-flash',
  'bytedance-seed/seed-2.0-mini',
  'anthropic/claude-sonnet-5',
] as const;

const CANDIDATES: Array<{
  id: string;
  name: string;
  vendor: string;
  vision: boolean;
  why: string;
}> = [
  {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    vendor: 'MoonshotAI',
    vision: true,
    why: 'Frontier open-weight multimodal; BenchAlign ~#5; structured + reasoning + vision',
  },
  {
    id: 'qwen/qwen3.8-flash',
    name: 'Qwen3.8 Flash',
    vendor: 'Qwen',
    vision: true,
    why: 'Cheap fast multimodal with structured outputs and 1M context',
  },
  {
    id: 'bytedance-seed/seed-2-1-turbo',
    name: 'Seed 2.1 Turbo',
    vendor: 'ByteDance',
    vision: true,
    why: 'Successor-class Seed turbo vs our Seed 2.0 Mini',
  },
  {
    id: 'z-ai/glm-5.3',
    name: 'GLM-5.3',
    vendor: 'Z.ai',
    vision: false,
    why: 'Full GLM-5.3 now advertises structured_outputs (we skipped it for that)',
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash',
    vendor: 'DeepSeek',
    vision: false,
    why: 'Highest-volume cheap DeepSeek; text-only speed SKU vs V4 Pro',
  },
  {
    id: 'minimax/minimax-m3',
    name: 'MiniMax M3',
    vendor: 'MiniMax',
    vision: true,
    why: 'Native image+video input, 1M context, structured + reasoning',
  },
  {
    id: 'openai/gpt-5.6-luna-pro',
    name: 'GPT-5.6 Luna Pro',
    vendor: 'OpenAI',
    vision: true,
    why: 'Same Luna weights with reasoning.mode=pro — a first-party quality SKU',
  },
];

const JUDGE_MODEL = 'google/gemini-3.7-flash';

/** Production auto-style schema wraps `.catch()` / `preprocess`, which Anthropic
 *  rejects as an invalid enum in strict structured output. The inner object is
 *  what we actually want the model to emit. */
const autoStyleEvalSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.enum(STYLE_CATEGORIES),
  tags: z.array(z.string()),
  mood: z.string(),
  artStyle: z.string(),
  medium: z.string(),
  lighting: z.string(),
  colorPalette: z.array(z.string()),
  colorGrading: z.string(),
  camera: z.string(),
  shots: z.string(),
  pace: z.enum(STYLE_PACE_VALUES),
  energy: z.number(),
  references: z.array(z.string()),
});
const WEIGHTS: Record<CallId, number> = {
  'split-screenplay': 1.2,
  'split-prose': 1.2,
  bibles: 1.0,
  'auto-style': 0.6,
  talent: 0.5,
  location: 0.5,
  visual: 1.2,
  motion: 1.2,
  music: 0.6,
};

function parseArg(name: string): string | undefined {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function prodEffort(call: CallId): Effort {
  if (call === 'talent' || call === 'location' || call === 'music')
    return 'none';
  return 'medium';
}

type ModelSpec = {
  id: string;
  name: string;
  vendor: string;
  vision: boolean;
  candidate: boolean;
};

function catalogModels(includeHidden: boolean): ModelSpec[] {
  return SCRIPT_ANALYSIS_MODELS.filter(
    (m) => includeHidden || isSelectableAnalysisModelId(m.id)
  ).map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    vision: m.vision,
    candidate: false,
  }));
}

function isCallId(value: string): value is CallId {
  return (CALLS as readonly string[]).includes(value);
}

function isEvalRow(value: unknown): value is EvalRow {
  if (!value || typeof value !== 'object') return false;
  return (
    'key' in value &&
    typeof value.key === 'string' &&
    'model' in value &&
    typeof value.model === 'string' &&
    'call' in value &&
    typeof value.call === 'string'
  );
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type Job = {
  key: string;
  model: ModelSpec;
  effort: Effort;
  call: CallId;
};

function buildJobs(opts: {
  models: ModelSpec[];
  calls: CallId[];
  efforts: Array<Effort | 'prod'>;
  sweep: boolean;
  candidates: ModelSpec[];
}): Job[] {
  const jobs: Job[] = [];
  const add = (model: ModelSpec, effort: Effort, call: CallId) => {
    jobs.push({
      key: `${model.id}|${effort}|${call}`,
      model,
      effort,
      call,
    });
  };
  for (const model of opts.models) {
    for (const call of opts.calls) {
      for (const effort of opts.efforts) {
        add(model, effort === 'prod' ? prodEffort(call) : effort, call);
      }
    }
  }
  for (const model of opts.candidates) {
    for (const call of opts.calls) {
      add(model, prodEffort(call), call);
    }
  }
  if (opts.sweep) {
    const sweepCalls: CallId[] = ['split-screenplay', 'visual', 'motion'];
    const sweepEfforts: Effort[] = ['none', 'low', 'high'];
    for (const id of SPEED_SWEEP_MODELS) {
      const model =
        opts.models.find((m) => m.id === id) ??
        catalogModels(true).find((m) => m.id === id);
      if (!model) continue;
      for (const call of sweepCalls) {
        if (!opts.calls.includes(call)) continue;
        for (const effort of sweepEfforts) {
          add(model, effort, call);
        }
      }
    }
  }
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (seen.has(j.key)) return false;
    seen.add(j.key);
    return true;
  });
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item, i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function checkpoint(path: string, rows: EvalRow[]) {
  writeFileSync(
    path,
    JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)
  );
}

async function judgeText(opts: {
  title: string;
  rubric: string;
  payload: string;
}): Promise<number | undefined> {
  const { messages } = {
    messages: [
      {
        role: 'system' as const,
        content: `You are a strict, calibrated judge of film-production LLM output. Score 0-10. Be harsh on generic, ungrounded, or schema-violating work. Return only the structured object.`,
      },
      {
        role: 'user' as const,
        content: `${opts.title}\n\nRubric:\n${opts.rubric}\n\nOutput to score:\n${opts.payload}`,
      },
    ],
  };
  const result = await timedStructuredCall({
    model: JUDGE_MODEL,
    messages,
    schema: judgeSchema,
    effort: 'none',
    observationName: 'eval-analysis-judge',
    timeoutMs: 60_000,
  });
  if (!result.ok || result.parsed === undefined) return undefined;
  const s = result.parsed.score;
  if (!Number.isFinite(s)) return undefined;
  return Math.min(10, Math.max(0, s));
}

async function runCall(
  gold: EvalGold,
  job: Job,
  skipJudge: boolean
): Promise<{
  structural: number;
  judge: number | undefined;
  details: Record<string, unknown>;
  call: Awaited<ReturnType<typeof timedStructuredCall<unknown>>>;
}> {
  const timeoutMs =
    job.effort === 'high' || job.effort === 'xhigh' ? 300_000 : 180_000;
  const model = job.model.id;

  if (job.call === 'split-screenplay' || job.call === 'split-prose') {
    const script =
      job.call === 'split-screenplay' ? gold.screenplay : PROSE_SCRIPT;
    const { messages } = await getChatPrompt(
      'phase/scene-splitting-boundaries-chat',
      {
        script: addLineGutter(script),
      }
    );
    const call = await timedStructuredCall({
      model,
      messages,
      schema: sceneSplitScenesResultSchema,
      effort: job.effort,
      observationName: `eval-analysis-${job.call}`,
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreSceneSplit({
      script,
      result: call.parsed,
      goldHeadingStarts:
        job.call === 'split-screenplay'
          ? gold.screenplayHeadingStarts
          : undefined,
      goldSceneCount:
        job.call === 'split-screenplay'
          ? gold.screenplayHeadingStarts.length
          : PROSE_GOLD_BEATS,
    });
    const judge = skipJudge
      ? undefined
      : await judgeText({
          title: 'Scene-split boundaries for a short film/ad.',
          rubric:
            '10: every cinematic beat is its own one-shot scene, quotes are verbatim, no missing or merged action. 5: roughly right count but sloppy quotes or merged cuts. 0: unusable / one blob / invented text.',
          payload: JSON.stringify(call.parsed, null, 2).slice(0, 6000),
        });
    return { structural: scored.quality, judge, details: scored.details, call };
  }

  if (job.call === 'bibles') {
    const { messages } = await getChatPrompt('phase/scene-bibles-chat', {
      script: addLineGutter(gold.screenplay),
      elements: '(none)',
    });
    const call = await timedStructuredCall({
      model,
      messages,
      schema: sceneSplitBiblesResultSchema,
      effort: job.effort,
      observationName: 'eval-analysis-bibles',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreBibles(call.parsed, gutterLineCount(gold.screenplay));
    const judge = skipJudge
      ? undefined
      : await judgeText({
          title:
            'Character/location/element bibles for a lipstick-ad screenplay starring SCARLETT VEGA.',
          rubric:
            '10: complete physical + clothing specs, snake_case tags starting with the name slug, every distinct location, a coral-lipstick element. 0: missing lead character or empty bibles.',
          payload: JSON.stringify(call.parsed, null, 2).slice(0, 7000),
        });
    return { structural: scored.quality, judge, details: scored.details, call };
  }

  if (job.call === 'auto-style') {
    const { messages } = await getChatPrompt('phase/automatic-style-chat', {
      script: gold.screenplay,
      aspectRatio: gold.aspectRatio,
      categories: STYLE_CATEGORIES.join(', '),
      paces: STYLE_PACE_VALUES.join(', '),
    });
    const call = await timedStructuredCall({
      model,
      messages,
      schema: autoStyleEvalSchema,
      effort: job.effort,
      observationName: 'eval-analysis-auto-style',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreAutoStyle(call.parsed);
    const judge = skipJudge
      ? undefined
      : await judgeText({
          title:
            'Automatic style bible derived from a kinetic NYC lipstick ad.',
          rubric:
            '10: specific, shootable look (lighting, stock, palette hexes, camera) that fits a social-first product ad. 0: generic mood adjectives, invalid palette, or collapsed fields.',
          payload: JSON.stringify(call.parsed, null, 2).slice(0, 4000),
        });
    return { structural: scored.quality, judge, details: scored.details, call };
  }

  if (job.call === 'talent') {
    const vars = buildMatchingPromptVariables(
      TALENT_CASE.characters,
      TALENT_CASE.talent
    );
    const { messages } = await getChatPrompt(
      'phase/talent-matching-chat',
      vars
    );
    const call = await timedStructuredCall({
      model,
      messages,
      schema: talentMatchResponseSchema,
      effort: job.effort,
      observationName: 'eval-analysis-talent',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreTalent(call.parsed.matches);
    return {
      structural: scored.quality,
      judge: undefined,
      details: scored.details,
      call,
    };
  }

  if (job.call === 'location') {
    const vars = buildLocationMatchingPromptVariables(
      LOCATION_CASE.scriptLocations,
      // Prompt builder only reads id/name/description/referenceImageUrl.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      LOCATION_CASE.library as unknown as LibraryLocation[]
    );
    const { messages } = await getChatPrompt(
      'phase/location-matching-chat',
      vars
    );
    const call = await timedStructuredCall({
      model,
      messages,
      schema: locationMatchResponseSchema,
      effort: job.effort,
      observationName: 'eval-analysis-location',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreLocation(call.parsed.matches);
    return {
      structural: scored.quality,
      judge: undefined,
      details: scored.details,
      call,
    };
  }

  if (job.call === 'visual' || job.call === 'motion') {
    const narrowed = narrowShotPromptContext({
      scene: gold.focusScene,
      styleConfig: gold.styleConfig,
      characterBible: gold.characterBible,
      locationBible: gold.locationBible,
      elementBible: gold.elementBible,
      aspectRatio: gold.aspectRatio,
      analysisModel: model,
    });
    const promptName =
      job.call === 'visual'
        ? 'phase/visual-prompt-scene-generation-chat'
        : 'phase/motion-prompt-scene-generation-chat';
    const variables: Record<string, string> = {
      scene: JSON.stringify(gold.focusScene, null, 2),
      sceneBefore: gold.sceneBefore
        ? JSON.stringify(gold.sceneBefore, null, 2)
        : '(none)',
      sceneAfter: gold.sceneAfter
        ? JSON.stringify(gold.sceneAfter, null, 2)
        : '(none)',
      characterBible: JSON.stringify(narrowed.characterBible, null, 2),
      locationBible: JSON.stringify(narrowed.locationBible, null, 2),
      elementBible: JSON.stringify(narrowed.elementBible, null, 2),
      styleConfig: JSON.stringify(gold.styleConfig, null, 2),
      aspectRatio: gold.aspectRatio,
    };
    if (job.call === 'motion') {
      variables.startingFrameNote = job.model.vision
        ? 'The rendered starting frame is attached below as an image — animate strictly from it.'
        : 'No rendered starting frame exists yet — derive the motion strictly from the scene data below.';
    }
    const { messages: raw } = await getChatPrompt(promptName, variables);
    const messages =
      job.call === 'motion' && job.model.vision
        ? attachVision(raw, gold.startingFrameDataUri)
        : raw;
    if (job.call === 'visual') {
      const call = await timedStructuredCall({
        model,
        messages,
        schema: visualPromptResultSchema,
        effort: job.effort,
        observationName: 'eval-analysis-visual',
        timeoutMs,
      });
      if (!call.ok || !call.parsed) {
        return {
          structural: 0,
          judge: undefined,
          details: { error: call.error },
          call,
        };
      }
      const parsed = call.parsed;
      const scored = scoreVisual(parsed.visual.fullPrompt, 'SCARLETT VEGA');
      const judge = skipJudge
        ? undefined
        : await judgeText({
            title:
              'Starting-frame image prompt for a one-shot lipstick-ad scene.',
            rubric:
              '10: 80–120 words, shot size+lens first, SCARLETT VEGA in CAPS, no face/hair/clothing invented, photographable physics, Product Ad style. 0: identity leakage, on-screen text, or unshootable staging.',
            payload: parsed.visual.fullPrompt,
          });
      return {
        structural: scored.quality,
        judge,
        details: scored.details,
        call,
      };
    }
    const call = await timedStructuredCall({
      model,
      messages,
      schema: motionPromptSchema,
      effort: job.effort,
      observationName: 'eval-analysis-motion',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const parsed = call.parsed;
    const hasDialogue = gold.focusScene.originalScript.dialogue.length > 0;
    const scored = scoreMotion(
      parsed.fullPrompt,
      hasDialogue,
      parsed.dialogue?.presence
    );
    const judge = skipJudge
      ? undefined
      : await judgeText({
          title: job.model.vision
            ? 'Motion prompt that must continue FROM an attached starting still (woman at a kitchen counter reaching for a coral lipstick box).'
            : 'Motion prompt (text-only, no still).',
          rubric: job.model.vision
            ? '10: continues the exact reach/pose, exactly one camera move with a pacing adverb, verbs not appearance, no music, dialogue performance if lines exist. 0: contradicts the still, stacked camera moves, or static description.'
            : '10: one camera move, verbs, no appearance recap, no music. 0: stacked moves or static recap.',
          payload: parsed.fullPrompt,
        });
    return { structural: scored.quality, judge, details: scored.details, call };
  }

  if (job.call === 'music') {
    const summaries = buildMusicSceneSummaries(gold.scenes);
    const { messages } = await getChatPrompt('phase/music-design-chat', {
      scenes: JSON.stringify(summaries, null, 2),
      sceneCount: String(summaries.length),
    });
    const call = await timedStructuredCall({
      model,
      messages,
      schema: musicDesignResultSchema,
      effort: job.effort,
      observationName: 'eval-analysis-music',
      timeoutMs,
    });
    if (!call.ok || !call.parsed) {
      return {
        structural: 0,
        judge: undefined,
        details: { error: call.error },
        call,
      };
    }
    const scored = scoreMusic({
      tags: call.parsed.tags,
      prompt: call.parsed.prompt,
      scenes: call.parsed.scenes,
      expectedScenes: gold.scenes.length,
    });
    const judge = skipJudge
      ? undefined
      : await judgeText({
          title:
            'Sequence-level instrumental underscore for a kinetic NYC lipstick ad.',
          rubric:
            '10: tags start with instrumental, no vocals, 1–2 sentence prompt with an arc, per-scene presence that is not all identical. 0: vocals, missing instrumental, or empty prompt.',
          payload: JSON.stringify(
            {
              tags: call.parsed.tags,
              prompt: call.parsed.prompt,
              scenes: call.parsed.scenes,
            },
            null,
            2
          ).slice(0, 4000),
        });
    return { structural: scored.quality, judge, details: scored.details, call };
  }

  throw new Error('Unknown analysis eval call');
}

async function main() {
  const quick = hasFlag('quick');
  const full = hasFlag('full');
  const includeHidden = hasFlag('include-hidden');
  const noJudge = hasFlag('no-judge');
  const noCandidates = hasFlag('no-candidates');
  const noSweep = hasFlag('no-sweep') || quick;
  const concurrency = Math.max(
    1,
    Number(parseArg('concurrency') ?? (quick ? '2' : '3'))
  );
  const outDir = resolve(parseArg('out') ?? '.tmp/eval-analysis');
  mkdirSync(outDir, { recursive: true });
  const checkpointPath = resolve(outDir, 'results.json');

  const callFilter = parseList(parseArg('calls'));
  const calls = (callFilter ?? [...CALLS]).filter(isCallId);
  if (calls.length === 0) {
    console.error('No valid --calls');
    process.exit(1);
  }

  const effortRaw =
    parseList(parseArg('efforts')) ?? (quick ? ['medium'] : ['prod']);
  const efforts = effortRaw.filter(
    (e): e is Effort | 'prod' =>
      e === 'prod' || (EFFORTS as readonly string[]).includes(e)
  );

  const catalog = catalogModels(includeHidden);
  const modelFilter = parseList(parseArg('models'));
  let models: ModelSpec[] = catalog;
  if (quick && !modelFilter) {
    models = catalog.filter((m) =>
      [
        'google/gemini-3.7-flash',
        'z-ai/glm-5.3-flash',
        'anthropic/claude-opus-5-fast',
      ].includes(m.id)
    );
  }
  if (modelFilter) {
    models = modelFilter.map((id) => {
      const known =
        catalog.find((m) => m.id === id) ??
        catalogModels(true).find((m) => m.id === id);
      if (known) return known;
      const cand = CANDIDATES.find((c) => c.id === id);
      if (cand) {
        return {
          id: cand.id,
          name: cand.name,
          vendor: cand.vendor,
          vision: cand.vision,
          candidate: true,
        };
      }
      const registered = getAnalysisModelById(id);
      if (registered) {
        return {
          id: registered.id,
          name: registered.name,
          vendor: registered.vendor,
          vision: registered.vision,
          candidate: false,
        };
      }
      return {
        id,
        name: id,
        vendor: 'Unknown',
        vision: true,
        candidate: true,
      };
    });
  }

  const candidateSpecs: ModelSpec[] =
    noCandidates || quick
      ? []
      : CANDIDATES.map((c) => ({
          id: c.id,
          name: c.name,
          vendor: c.vendor,
          vision: c.vision,
          candidate: true,
        }));

  const jobs = buildJobs({
    models,
    calls: quick
      ? calls.filter((c) =>
          ['split-screenplay', 'visual', 'motion'].includes(c)
        )
      : calls,
    efforts,
    sweep: !noSweep,
    candidates: candidateSpecs,
  });

  if (full) {
    for (const model of models.filter(
      (m) => m.id.startsWith('openai/gpt-5.6') || m.id.startsWith('x-ai/')
    )) {
      for (const call of ['split-screenplay', 'visual', 'motion'] as CallId[]) {
        if (!calls.includes(call)) continue;
        const key = `${model.id}|xhigh|${call}`;
        if (jobs.some((j) => j.key === key)) continue;
        jobs.push({ key, model, effort: 'xhigh', call });
      }
    }
  }

  if (hasFlag('list')) {
    console.log(`${jobs.length} jobs`);
    for (const j of jobs) console.log(j.key);
    return;
  }

  console.log(
    `analysis eval  jobs=${jobs.length}  concurrency=${concurrency}  out=${outDir}  judge=${noJudge ? 'off' : JUDGE_MODEL}`
  );
  console.log(
    `models=${models.map((m) => m.id).join(', ') || '(none)'}  candidates=${candidateSpecs.map((c) => c.id).join(', ') || '(none)'}`
  );

  let rows: EvalRow[] = [];
  if (hasFlag('resume') && existsSync(checkpointPath)) {
    const prev: unknown = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    rows =
      prev &&
      typeof prev === 'object' &&
      'rows' in prev &&
      Array.isArray(prev.rows)
        ? prev.rows.filter(isEvalRow)
        : [];
    const kept = rows.filter((r) => r.ok);
    const retried = rows.length - kept.length;
    rows = kept;
    if (retried > 0) {
      console.log(
        `resume: ${kept.length} ok rows, retrying ${retried} failures`
      );
    } else {
      console.log(`resume: ${rows.length} rows already on disk`);
    }
  }
  const done = new Set(rows.map((r) => r.key));
  const pending = jobs.filter((j) => !done.has(j.key));

  const gold = loadEvalGold();
  let gate = Promise.resolve();
  const saveRow = (row: EvalRow) =>
    new Promise<void>((resolveDone) => {
      gate = gate.then(() => {
        rows.push(row);
        checkpoint(checkpointPath, rows);
        resolveDone();
      });
    });
  const exec = async (job: Job): Promise<EvalRow> => {
    const started = Date.now();
    try {
      const result = await runCall(gold, job, noJudge);
      const quality = blend(result.structural, result.judge);
      const row: EvalRow = {
        key: job.key,
        model: job.model.id,
        modelName: job.model.name,
        family: job.model.vendor,
        candidate: job.model.candidate,
        vision: job.model.vision,
        effort: job.effort,
        call: job.call,
        ok: result.call.ok,
        quality: result.call.ok ? quality : 0,
        structural: result.structural,
        judge: result.judge,
        totalMs: result.call.totalMs,
        ttftMs: result.call.ttftMs,
        costUsd: result.call.costUsd,
        promptTokens: result.call.promptTokens,
        completionTokens: result.call.completionTokens,
        error: result.call.error,
        details: result.details,
      };
      const flag = row.ok ? `${row.quality.toFixed(0).padStart(3)}q` : 'FAIL';
      console.log(
        `${flag}  ${(row.totalMs / 1000).toFixed(1).padStart(6)}s  ${job.model.name}  ${job.effort}  ${job.call}${row.error ? `  ${row.error.slice(0, 120)}` : ''}`
      );
      await saveRow(row);
      return row;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL  ${job.key}  ${message.slice(0, 120)}`);
      const row: EvalRow = {
        key: job.key,
        model: job.model.id,
        modelName: job.model.name,
        family: job.model.vendor,
        candidate: job.model.candidate,
        vision: job.model.vision,
        effort: job.effort,
        call: job.call,
        ok: false,
        quality: 0,
        structural: 0,
        judge: undefined,
        totalMs: Date.now() - started,
        ttftMs: undefined,
        costUsd: undefined,
        promptTokens: undefined,
        completionTokens: undefined,
        error: message,
        details: {},
      };
      await saveRow(row);
      return row;
    }
  };

  await mapPool(pending, concurrency, exec);
  checkpoint(checkpointPath, rows);

  const { htmlPath, mdPath } = writeReport(outDir, rows);
  console.log(`\nWrote ${htmlPath}`);
  console.log(`Wrote ${mdPath}`);
  printOverall(rows);
}

function printOverall(rows: EvalRow[]) {
  const by = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const k = `${row.model}|${row.effort}`;
    const list = by.get(k) ?? [];
    list.push(row);
    by.set(k, list);
  }
  const lines: Array<{ label: string; q: number; s: number; ok: number }> = [];
  for (const [, list] of by) {
    const ok = list.filter((r) => r.ok);
    let w = 0;
    let q = 0;
    for (const r of ok) {
      const weight = isCallId(r.call) ? WEIGHTS[r.call] : 1;
      w += weight;
      q += weight * r.quality;
    }
    const first = list[0];
    if (!first) continue;
    lines.push({
      label: `${first.modelName} ${first.effort}${first.candidate ? ' [cand]' : ''}`,
      q: w > 0 ? q / w : 0,
      s: list.reduce((a, r) => a + r.totalMs, 0) / 1000,
      ok: ok.length / list.length,
    });
  }
  lines.sort((a, b) => b.q - a.q);
  console.log('\nWeighted overall (quality / total-seconds / ok):');
  for (const line of lines.slice(0, 20)) {
    console.log(
      `  ${line.q.toFixed(1).padStart(5)}  ${line.s.toFixed(0).padStart(5)}s  ${(line.ok * 100).toFixed(0).padStart(3)}%  ${line.label}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
