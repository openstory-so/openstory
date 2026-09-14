/**
 * Multi-turn script-enhance generation: first pass, optional duration
 * correction, TOTAL strip. Billing / model choice stay in
 * `script-enhancement.ts`; this module is the testable loop.
 */

import {
  buildDurationCorrectionPrompt,
  createTotalLineFilter,
  durationCorrectionNeeded,
  parseSceneDurationLabels,
  stripTotalLine,
} from '@/models/enhance-duration';
import type { ChatMessage } from '@/platform/server/ai/prompts-index';

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
  generate: EnhanceGenerate;
}): AsyncGenerator<EnhanceChunk> {
  const first = yield* streamTurn(opts.generate, opts.messages, true);

  const labels = parseSceneDurationLabels(first);
  const needsCorrection = durationCorrectionNeeded({
    labels,
    targetSeconds: opts.targetSeconds,
  });

  if (needsCorrection) {
    const sum = labels.reduce((a, b) => a + b, 0);
    const correction = buildDurationCorrectionPrompt({
      sum,
      targetSeconds: opts.targetSeconds,
      sceneCount: labels.length,
    });
    const corrected = yield* streamTurn(
      opts.generate,
      [
        ...opts.messages,
        { role: 'assistant', content: first },
        { role: 'user', content: correction },
      ],
      false
    );
    yield { delta: corrected, replace: true };
  }
}
