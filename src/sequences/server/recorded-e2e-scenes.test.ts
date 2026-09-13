/**
 * The shot-list aimock fixture matches on the exact user message, so the
 * `<SCENES>` block the workflow formats from the recorded split must equal
 * the block the fixture was (re)written with — including the per-scene
 * `shots:` budget lines (#1593). This is what keeps the recorded e2e replay
 * green when the prompt formatter changes.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
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

  it("labels every recorded scene's shots, so the grid never enters the replay", () => {
    const { assembled } = recordedSplitScenes();
    for (const scene of assembled.scenes) {
      expect(scene.shotLabelSeconds?.length).toBeGreaterThan(0);
    }
    // Unused import guard: the helper is part of this module's public surface.
    expect(typeof extractTaggedJson).toBe('function');
  });
});
