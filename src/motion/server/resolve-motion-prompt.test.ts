import { describe, expect, it } from 'vitest';
import type { AssemblableMotionPrompt } from '@/shots/scene-analysis.schema';
import {
  motionPromptFromVersion,
  resolveMotionPrompt,
  resolveMotionPromptFromVersion,
} from './resolve-motion-prompt';

// Kling and Grok both output audio. Grok has no generate_audio field; the
// lines still go in the prompt.
const AUDIO_MODEL = 'kling_v3_pro' as const;
const GROK_MODEL = 'grok_imagine_video_1_5' as const;

// What the shot says now (#1657) — resolved from the shot's dialogue
// version by the caller, never read off the prompt row.
const dialogue = {
  presence: true,
  lines: [
    {
      character: 'Detective',
      line: 'It was never about the money.',
      tone: 'weary',
    },
  ],
};

const versionRow = {
  text: 'Slow dolly-in on the detective at her desk.',
  // A pre-#1657 row still carries a copy. It must not reach the prompt.
  dialogue: {
    presence: true,
    lines: [
      {
        character: 'Detective',
        line: 'A stale line nobody says any more.',
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
    expect(motionPromptFromVersion(versionRow, dialogue)).toEqual({
      fullPrompt: versionRow.text,
      dialogue,
      audio: versionRow.audio,
    });
  });
});

describe('resolveMotionPrompt', () => {
  it('assembles a model-specific prompt when a motion prompt is present', () => {
    const out = resolveMotionPrompt(
      {
        motionPrompt: motionPromptFromVersion(versionRow, dialogue),
        description: null,
      },
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
      { dialogue, description: null },
      AUDIO_MODEL
    );
    expect(out).toContain(versionRow.text);
    expect(out).toContain('It was never about the money.');
    // The row's own copy never reaches the prompt.
    expect(out).not.toContain('A stale line nobody says any more.');
  });

  it('falls back to the scene script when there is no version, else empty', () => {
    expect(
      resolveMotionPromptFromVersion(
        null,
        { dialogue, description: 'desc fallback' },
        GROK_MODEL
      )
    ).toBe('desc fallback');
    expect(
      resolveMotionPromptFromVersion(
        undefined,
        { dialogue, description: null },
        GROK_MODEL
      )
    ).toBe('');
  });

  it('puts the caller lines in a Grok prompt and ignores the row copy', () => {
    const out = resolveMotionPromptFromVersion(
      versionRow,
      { dialogue, description: null },
      GROK_MODEL
    );
    expect(out).toContain(versionRow.text);
    expect(out).toContain('It was never about the money.');
    expect(out).not.toContain('A stale line nobody says any more.');
  });
});
