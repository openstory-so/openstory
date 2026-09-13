import { describe, expect, it } from 'vitest';
import {
  parseSceneDurationLabels,
  sumSceneDurations,
} from '@/models/enhance-duration';
import {
  runEnhanceScriptTurns,
  type EnhanceGenerate,
} from './enhance-script-turns';
import type { ChatMessage } from '@/platform/server/ai/prompts-index';

function scriptFromLabels(seconds: number[]): string {
  return seconds
    .map((s, i) => `Scene ${i + 1} — ${s}s\nBeat ${i + 1}.`)
    .join('\n\n');
}

function generateFrom(scripts: string[]): EnhanceGenerate {
  let i = 0;
  return async function* (_messages: ChatMessage[]) {
    const next = scripts[i++] ?? scripts[scripts.length - 1] ?? '';
    // Split so TOTAL can arrive in a later chunk.
    const splitAt = next.lastIndexOf('\nTOTAL:');
    if (splitAt >= 0) {
      yield { delta: next.slice(0, splitAt + 1) };
      yield { delta: next.slice(splitAt + 1) };
    } else {
      yield { delta: next };
    }
  };
}

async function drain(
  gen: AsyncGenerator<{
    delta: string;
    replace?: boolean;
  }>
) {
  let script = '';
  for await (const chunk of gen) {
    if (chunk.replace) script = chunk.delta;
    else script += chunk.delta;
  }
  return { script: script.trim() };
}

describe('runEnhanceScriptTurns', () => {
  it('streams an on-target H3 Max script and strips TOTAL without a second turn', async () => {
    const body = scriptFromLabels([6, 6, 6, 6, 6]);
    const generate = generateFrom([`${body}\nTOTAL: 30s`]);
    const { script } = await drain(
      runEnhanceScriptTurns({
        messages: [{ role: 'user', content: 'brief' }],
        targetSeconds: 30,
        videoModel: 'minimax_h3_max',
        generate,
      })
    );
    expect(script).toBe(body);
    expect(script).not.toContain('TOTAL:');
    expect(sumSceneDurations(script)).toBe(30);
  });

  it('sends a corrective turn when labels overshoot, then replaces', async () => {
    const overshoot = `${scriptFromLabels(Array.from({ length: 9 }, () => 5))}\nTOTAL: 45s`;
    const fixed = `${scriptFromLabels([6, 6, 6, 6, 6])}\nTOTAL: 30s`;
    const seen: ChatMessage[][] = [];
    const inner = generateFrom([overshoot, fixed]);
    const generate: EnhanceGenerate = async function* (messages) {
      seen.push(messages);
      yield* inner(messages);
    };
    const { script } = await drain(
      runEnhanceScriptTurns({
        messages: [{ role: 'user', content: 'nine beats plus a title card' }],
        targetSeconds: 30,
        videoModel: 'minimax_h3_max',
        generate,
      })
    );
    expect(seen).toHaveLength(2);
    const correction = seen[1]?.[2];
    expect(correction?.role).toBe('user');
    expect(
      typeof correction?.content === 'string' && correction.content
    ).toContain('sum to 45s');
    expect(parseSceneDurationLabels(script)).toEqual([6, 6, 6, 6, 6]);
    expect(script).not.toContain('TOTAL:');
  });

  it('corrects off-grid 4s labels on H3 Max even when they already sum to 30s', async () => {
    const first = `${scriptFromLabels([4, 4, 4, 4, 4, 5, 5])}\nTOTAL: 30s`;
    const second = `${scriptFromLabels([6, 6, 6, 6, 6])}\nTOTAL: 30s`;
    const generate = generateFrom([first, second]);
    const { script } = await drain(
      runEnhanceScriptTurns({
        messages: [{ role: 'user', content: 'brief' }],
        targetSeconds: 30,
        videoModel: 'minimax_h3_max',
        generate,
      })
    );
    expect(
      parseSceneDurationLabels(script).every((s) => s >= 5 && s <= 15)
    ).toBe(true);
    expect(sumSceneDurations(script)).toBe(30);
  });
});
