#!/usr/bin/env bun
/**
 * Duration-sum eval for `script/enhance` (issue #1374).
 *
 * Replays a 9-beat + title-card brief through the live enhance user prompt
 * (clip grid + hard sum + TOTAL: self-check) and reports whether labeled
 * scene durations land within ±2s of the target.
 *
 * Usage:
 *   bun scripts/eval-enhance-duration.ts
 *   bun scripts/eval-enhance-duration.ts --runs 3
 *   bun scripts/eval-enhance-duration.ts --video-model ltx_2_3_pro
 *
 * Needs OPENROUTER_KEY. Report-only — never writes to the DB.
 */
import {
  callLLM,
  ENHANCE_REASONING,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import {
  parseSceneDurationLabels,
  stripTotalLine,
  sumSceneDurations,
} from '@/lib/ai/enhance-duration';
import {
  DEFAULT_VIDEO_MODEL,
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { createUserPrompt } from '@/lib/ai/script-enhancer';
import { WORKFLOW_TEXT_PROMPTS } from '@/lib/prompts/workflow-prompts';

const BRIEF = `A 30-second travel film across eight places, then a title card.

1. Dawn over Shibuya Crossing, Tokyo — a courier weaves the scramble.
2. Espresso slammed on zinc in a Milan café — steam, a ringing spoon.
3. Motorbike through Bangkok rain — neon in the puddles.
4. Night market in Taipei — a skewer pulled off the grill.
5. Surf at Bondi — a board-tuck into a small wave.
6. Neon subway in Seoul — doors close on a last-second jump.
7. Rooftop in New York — a paper plane over the grid.
8. Desert highway in Morocco — a scarf snaps in the wind.
9. Title card: THE WORLD IS CLOSE.`;

const TARGET = 30;
const TOLERANCE = 2;

function parseArg(name: string): string | undefined {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const RUNS = Math.max(1, Number(parseArg('runs') ?? '3'));
const videoArg = parseArg('video-model') ?? DEFAULT_VIDEO_MODEL;
if (!isValidImageToVideoModel(videoArg)) {
  console.error(`Invalid --video-model "${videoArg}"`);
  process.exit(1);
}
const VIDEO_MODEL: ImageToVideoModel = videoArg;

const openRouterKey = process.env.OPENROUTER_KEY;
if (!openRouterKey) {
  console.error('OPENROUTER_KEY is required (set in .env.local).');
  process.exit(1);
}

const SYSTEM = `${WORKFLOW_TEXT_PROMPTS['script/enhance'] ?? ''}

Return ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`;

async function enhanceOnce(): Promise<string> {
  const userPrompt = createUserPrompt(BRIEF, {
    targetDuration: TARGET,
    videoModel: VIDEO_MODEL,
    aspectRatio: '16:9',
  });
  return callLLM({
    model: RECOMMENDED_MODELS.creative,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    reasoning: ENHANCE_REASONING,
    observationName: 'eval-enhance-duration',
    apiKey: { key: openRouterKey, via: 'openrouter' },
  });
}

const sums: number[] = [];
let failed = 0;

console.log(
  `eval-enhance-duration  runs=${RUNS}  target=${TARGET}s  model=${VIDEO_MODEL}`
);

for (let i = 0; i < RUNS; i++) {
  const raw = await enhanceOnce();
  const script = stripTotalLine(raw);
  const labels = parseSceneDurationLabels(script);
  const sum = sumSceneDurations(script);
  sums.push(sum);
  const ok = Math.abs(sum - TARGET) <= TOLERANCE;
  if (!ok) failed += 1;
  console.log(
    `  run ${i + 1}: sum=${sum}s labels=[${labels.join(',')}] ${ok ? 'OK' : 'FAIL'}`
  );
}

console.log(`sums: ${sums.join(', ')}  failed=${failed}/${RUNS}`);
if (failed > 0) process.exit(1);
