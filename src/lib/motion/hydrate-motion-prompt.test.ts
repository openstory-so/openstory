import { describe, expect, it } from 'vitest';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import { hydrateMotionPromptFromScene } from './hydrate-motion-prompt';

const baseScene = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: {
    extract: 'SARAH speaks.',
    dialogue: [
      {
        character: 'SARAH',
        line: 'We need to leave.',
        tone: 'urgent',
      },
    ],
  },
  metadata: {
    title: 'T',
    durationSeconds: 5,
    location: 'INT. ROOM',
    timeOfDay: 'day',
    storyBeat: 'beat',
  },
  continuity: {
    characterTags: [],
    environmentTag: '',
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
} satisfies Scene;

const baseMotionPrompt = {
  fullPrompt: 'Slow dolly in.',
  dialogue: { presence: false, lines: [] },
  audio: { ambientSound: 'quiet room', soundEffects: [] },
} satisfies MotionPrompt;

describe('hydrateMotionPromptFromScene', () => {
  it('fills dialogue from originalScript when the LLM omitted it', () => {
    const result = hydrateMotionPromptFromScene(baseScene, baseMotionPrompt);
    expect(result.dialogue).toEqual({
      presence: true,
      lines: baseScene.originalScript.dialogue,
    });
  });

  it('leaves LLM-extracted dialogue untouched', () => {
    const withDialogue: MotionPrompt = {
      ...baseMotionPrompt,
      dialogue: {
        presence: true,
        lines: [
          {
            character: 'SARAH',
            line: 'Custom tone from model.',
            tone: 'whispered',
          },
        ],
      },
    };
    expect(hydrateMotionPromptFromScene(baseScene, withDialogue)).toBe(
      withDialogue
    );
  });

  it('does nothing when the scene has no script dialogue', () => {
    const silentScene: Scene = {
      ...baseScene,
      originalScript: { extract: 'No speech.', dialogue: [] },
    };
    expect(hydrateMotionPromptFromScene(silentScene, baseMotionPrompt)).toBe(
      baseMotionPrompt
    );
  });
});
