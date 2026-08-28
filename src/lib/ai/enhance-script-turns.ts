/**
 * Multi-turn script-enhance generation: first pass, optional duration
 * correction, grid rewrite, TOTAL strip. Billing / model choice stay in
 * `script-enhancement.ts`; this module is the testable loop.
 */

import {
  buildDurationCorrectionPrompt,
  createTotalLineFilter,
  durationCorrectionNeeded,
  maybeRewriteDurationLabels,
  parseSceneDurationLabels,
  stripTotalLine,
} from '@/lib/ai/enhance-duration';
import type { ImageToVideoModel } from '@/lib/ai/models';
import { durationGridForModel } from '@/lib/motion/snap-duration';
import type { ChatMessage } from '@/lib/prompts';

type EnhanceTextDelta = { delta: string; reasoning?: string };

export type EnhanceChunk = EnhanceTextDelta & {
  /** Replace the accumulated script (correction / label rewrite). */
  replace?: boolean;
};

export type EnhanceGenerate = (
  messages: ChatMessage[]
) => AsyncGenerator<EnhanceTextDelta>;

async function* streamTurn(
  generate: EnhanceGenerate,
  messages: ChatMessage[],
  yieldDeltas: boolean
): AsyncGenerator<EnhanceChunk, string> {
  const filter = createTotalLineFilter();
  let raw = '';
  for await (const chunk of generate(messages)) {
    if (chunk.reasoning) {
      yield { delta: '', reasoning: chunk.reasoning };
    }
    if (!chunk.delta) continue;
    raw += chunk.delta;
    const out = filter.push(chunk.delta);
    if (out && yieldDeltas) yield { delta: out };
  }
  const tail = filter.flush();
  if (tail && yieldDeltas) yield { delta: tail };
  return stripTotalLine(raw);
}

export async function* runEnhanceScriptTurns(opts: {
  messages: ChatMessage[];
  targetSeconds: number;
  videoModel: ImageToVideoModel;
  generate: EnhanceGenerate;
}): AsyncGenerator<EnhanceChunk> {
  const grid = durationGridForModel(opts.videoModel);

  const first = yield* streamTurn(opts.generate, opts.messages, true);

  let script = first;
  const labels = parseSceneDurationLabels(script);
  const needsCorrection = durationCorrectionNeeded({
    labels,
    targetSeconds: opts.targetSeconds,
    grid,
  });

  if (needsCorrection) {
    const sum = labels.reduce((a, b) => a + b, 0);
    const correction = buildDurationCorrectionPrompt({
      sum,
      targetSeconds: opts.targetSeconds,
      grid,
      sceneCount: labels.length,
    });
    script = yield* streamTurn(
      opts.generate,
      [
        ...opts.messages,
        { role: 'assistant', content: first },
        { role: 'user', content: correction },
      ],
      false
    );
  }

  const rewritten = maybeRewriteDurationLabels(script, opts.videoModel);
  if (needsCorrection || rewritten !== first) {
    yield { delta: rewritten, replace: true };
  }
}
