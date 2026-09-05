import { describe, expect, it } from 'vitest';
import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import {
  motionPromptFromVersion,
  resolveMotionPrompt,
  resolveMotionPromptFromVersion,
} from './resolve-motion-prompt';

// veo3_1 is audio-capable (Google → dialogue/audio enriched); grok is not
// (fullPrompt passes through untouched). Using both pins the model-specific
// assembly branch vs. the bare passthrough.
const AUDIO_MODEL = 'veo3_1' as const;
const NON_AUDIO_MODEL = 'grok_imagine_video_1_5' as const;

const versionRow = {
  text: 'Slow dolly-in on the detective at her desk.',
  dialogue: {
    presence: true,
    lines: [
      {
        character: 'Detective',
        line: 'It was never about the money.',
        tone: 'weary',
      },
    ],
  },
  audio: { ambientSound: 'rain on the window', soundEffects: [] },
} satisfies {
  text: string;
  dialogue: AssemblableMotionPrompt['dialogue'];
  audio: AssemblableMotionPrompt['audio'];
};

describe('motionPromptFromVersion', () => {
  it('maps a version row to an assemblable prompt (text → fullPrompt)', () => {
    expect(motionPromptFromVersion(versionRow)).toEqual({
      fullPrompt: versionRow.text,
      dialogue: versionRow.dialogue,
      audio: versionRow.audio,
    });
  });
});

describe('resolveMotionPrompt', () => {
  it('assembles a model-specific prompt when a motion prompt is present', () => {
    const out = resolveMotionPrompt(
      { motionPrompt: motionPromptFromVersion(versionRow), description: null },
      AUDIO_MODEL
    );
    // fullPrompt is the base; the audio model appends the dialogue line.
    expect(out).toContain(versionRow.text);
    expect(out).toContain('It was never about the money.');
  });

  it('falls back to the description when there is no motion prompt', () => {
    expect(
      resolveMotionPrompt(
        { motionPrompt: null, description: 'A quiet street at dawn.' },
        AUDIO_MODEL
      )
    ).toBe('A quiet street at dawn.');
  });

  it('returns an empty string when there is neither prompt nor description', () => {
    expect(
      resolveMotionPrompt(
        { motionPrompt: null, description: null },
        AUDIO_MODEL
      )
    ).toBe('');
  });
});

describe('resolveMotionPromptFromVersion', () => {
  it('assembles from the version row when one is selected', () => {
    const out = resolveMotionPromptFromVersion(
      versionRow,
      { description: null },
      AUDIO_MODEL
    );
    expect(out).toContain(versionRow.text);
    expect(out).toContain('It was never about the money.');
  });

  it('falls back to the scene script when there is no version, else empty', () => {
    expect(
      resolveMotionPromptFromVersion(
        null,
        { description: 'desc fallback' },
        NON_AUDIO_MODEL
      )
    ).toBe('desc fallback');
    expect(
      resolveMotionPromptFromVersion(
        undefined,
        { description: null },
        NON_AUDIO_MODEL
      )
    ).toBe('');
  });

  it('does not enrich when passing through a non-audio model', () => {
    const out = resolveMotionPromptFromVersion(
      versionRow,
      { description: null },
      NON_AUDIO_MODEL
    );
    // Non-audio model returns fullPrompt as-is — no dialogue appended.
    expect(out).toBe(versionRow.text);
  });
});
