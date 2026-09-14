/**
 * The shot-list aimock fixture matches on the exact user message, so the
 * `<SCENES>` block the workflow formats from the recorded split must equal
 * the block the fixture was (re)written with — including the per-scene
 * `shots:` budget lines (#1593). This is what keeps the recorded e2e replay
 * green when the prompt formatter changes.
 *
 * The recorded enhanced script still carries the OLD `Shot N — Xs` labels
 * Enhance used to write (#1486/#1593 era) — they are frozen fixture text.
 * Since #1621 the split no longer reads them as a coverage lock, so the
 * fixture's `shots:` lines were hand-updated to the grid-derived budget the
 * current code computes; the LLM's own shot-list response (and the resulting
 * shot durations, unchanged here because the old labels already landed on
 * the model's clip grid) did not need to change.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
import { getChatPrompt } from '@/platform/server/ai/prompts-index';
import { formatScenesForShotListPrompt } from '@/shots/shot-list-pass';
import {
  extractTaggedJson,
  loadOpenrouterStage,
  recordedSplitScenes,
} from './recorded-e2e-scenes';

function fixtureScenesBlock(): string {
  const message =
    loadOpenrouterStage('script-shot-list')[0]?.fixtures[0]?.match.userMessage;
  if (!message) throw new Error('No shot-list fixture');
  const start = message.indexOf('<SCENES>\n') + '<SCENES>\n'.length;
  const end = message.indexOf('\n</SCENES>');
  return message.slice(start, end);
}

describe('recorded script-bibles fixture', () => {
  it('matches the live scene-bibles-chat user message (#1629)', async () => {
    const recorded = loadOpenrouterStage('script-bibles').find((file) =>
      file.fixtures[0]?.match.userMessage.includes(
        'Downtown Apartment Bathroom'
      )
    )?.fixtures[0]?.match.userMessage;
    if (!recorded) throw new Error('No coral-lipstick script-bibles fixture');
    const scriptStart =
      recorded.indexOf('<USER_SCRIPT>\n') + '<USER_SCRIPT>\n'.length;
    const scriptEnd = recorded.indexOf('\n</USER_SCRIPT>');
    const elementsStart =
      recorded.indexOf(
        'Produce an elementBible entry for each one used in the script:\n'
      ) +
      'Produce an elementBible entry for each one used in the script:\n'.length;
    const elementsEnd = recorded.indexOf('\n</ELEMENTS>');
    const { messages } = await getChatPrompt('phase/scene-bibles-chat', {
      script: recorded.slice(scriptStart, scriptEnd),
      elements: recorded.slice(elementsStart, elementsEnd),
    });
    const user = messages.find((message) => message.role === 'user');
    expect(user && typeof user.content === 'string' ? user.content : '').toBe(
      recorded
    );
  });
});

describe('recorded shot-list fixture', () => {
  it('matches the <SCENES> block the workflow formats from the recorded split', () => {
    const { assembled } = recordedSplitScenes();
    expect(
      formatScenesForShotListPrompt(
        assembled.scenes,
        durationGridForModel(DEFAULT_VIDEO_MODEL)
      )
    ).toBe(fixtureScenesBlock());
  });

  it('carries no shotLabelSeconds: Enhance no longer locks shot count (#1621)', () => {
    const { assembled } = recordedSplitScenes();
    for (const scene of assembled.scenes) {
      expect('shotLabelSeconds' in scene).toBe(false);
    }
    // Unused import guard: the helper is part of this module's public surface.
    expect(typeof extractTaggedJson).toBe('function');
  });
});
