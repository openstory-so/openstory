import { describe, expect, it } from 'vitest';
import type { MotionPrompt } from '../ai/scene-analysis.schema';
import { assembleMotionPrompt } from './assemble-motion-prompt';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const dialogueWithTone: NonNullable<MotionPrompt['dialogue']> = {
  presence: true,
  lines: [
    {
      character: 'Sarah',
      line: 'We need to reconsider the entire approach.',
      tone: 'firm commanding',
    },
    {
      character: 'James',
      line: "I couldn't agree more.",
      tone: 'soft resigned',
    },
  ],
};

const audioData: NonNullable<MotionPrompt['audio']> = {
  ambientSound: 'quiet office hum with keyboard clicks',
  soundEffects: ['chair scrape', 'paper rustling'],
};

const fullPromptText =
  'Steadicam slow dolly forward from medium shot to close-up.\n\nSarah speaks firmly while gesturing. James nods in agreement.\n\nSubtle office sounds, papers flutter.';

function makeMotionPrompt(overrides: Partial<MotionPrompt> = {}): MotionPrompt {
  return {
    fullPrompt: fullPromptText,
    dialogue: dialogueWithTone,
    audio: audioData,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Kling v3 Pro (audio-capable — default model)
// ---------------------------------------------------------------------------

describe('assembleMotionPrompt', () => {
  describe('Kling v3 Pro (audio)', () => {
    const model = 'kling_v3_pro';

    it('starts with the fullPrompt as the base', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result.startsWith(fullPromptText)).toBe(true);
    });

    it('appends character labels with tone and dialogue text', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        '[Sarah, firm commanding]: "We need to reconsider the entire approach."'
      );
      expect(result).toContain(
        '[James, soft resigned]: "I couldn\'t agree more."'
      );
    });

    it('uses temporal markers between dialogue lines', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Immediately,');
    });

    it('appends ambient sound descriptions', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Ambient sounds:');
      expect(result).toContain('quiet office hum');
      expect(result).toContain('chair scrape');
    });

    it('omits dialogue section when not present', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: { presence: false, lines: [] },
        }),
        model,
      });

      expect(result).not.toContain('[Sarah');
      // Still has fullPrompt + audio
      expect(result.startsWith(fullPromptText)).toBe(true);
      expect(result).toContain('Ambient sounds:');
    });

    it('omits ambient sounds when no audio data, keeps the no-music direction', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({ audio: undefined }),
        model,
      });

      expect(result).not.toContain('Ambient sounds:');
      expect(result).toContain('No BGM, no music.');
      // Still has fullPrompt + dialogue
      expect(result).toContain('[Sarah');
    });

    it('suppresses model-generated music alongside the ambient sounds', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        'Ambient sounds: quiet office hum with keyboard clicks. chair scrape, paper rustling. No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Google Veo 3.1 (audio-capable)
  // ---------------------------------------------------------------------------

  describe('Google Veo 3.1 (audio)', () => {
    const model = 'veo3_1';

    it('starts with fullPrompt as the base', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result.startsWith(fullPromptText)).toBe(true);
    });

    it('appends dialogue as natural narrative with inline quotes', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        'Sarah says in a firm commanding voice, "We need to reconsider the entire approach."'
      );
      expect(result).toContain('James says in a soft resigned voice,');
    });

    it('appends Audio: section with ambient and SFX', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Audio:');
      expect(result).toContain('quiet office hum');
      expect(result).toContain('chair scrape');
    });

    it('keeps an Audio: section carrying the no-music direction when no audio data', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({ audio: undefined }),
        model,
      });

      expect(result).toContain(
        'Audio: No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.'
      );
      expect(result).not.toContain('quiet office hum');
    });

    it('suppresses model-generated music alongside the ambient and SFX', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        'Audio: quiet office hum with keyboard clicks. chair scrape, paper rustling. No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.'
      );
    });

    it('omits dialogue when not present', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: { presence: false, lines: [] },
        }),
        model,
      });

      expect(result).not.toContain('Sarah says');
      expect(result.startsWith(fullPromptText)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ByteDance Seedance 2.0 / 2.5 (audio — prose-woven sound + in-prompt guards)
  // ---------------------------------------------------------------------------

  describe.each(['seedance_v2', 'seedance_v2_5'] as const)(
    'ByteDance %s (audio)',
    (model) => {
      it('starts with fullPrompt as the base', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result.startsWith(fullPromptText)).toBe(true);
      });

      it('weaves sound as prose without labeled sections', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result).toContain('quiet office hum with keyboard clicks.');
        expect(result).toContain('chair scrape, paper rustling.');
        expect(result).not.toContain('Audio:');
        expect(result).not.toContain('Ambient sounds:');
      });

      it('formats dialogue as X says "…" in a [tone] voice', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result).toContain(
          'Sarah says "We need to reconsider the entire approach." in a firm commanding voice.'
        );
        expect(result).toContain(
          'James says "I couldn\'t agree more." in a soft resigned voice.'
        );
      });

      it('always appends the no-music and single-continuous-shot guards', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result).toContain(
          'No BGM, no music. Generate only dialogue, environmental sounds, and action sounds. Single continuous shot, no cuts.'
        );
      });

      it('adds the jitter guard only when the scene has characters', () => {
        const withCharacters = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
          characterTags: ['sarah', 'james'],
        });
        const withoutCharacters = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
          characterTags: [],
        });

        expect(withCharacters).toContain('Avoid jitter and bent limbs.');
        expect(withoutCharacters).not.toContain('Avoid jitter and bent limbs.');
      });

      it('omits dialogue and sound prose when absent, keeps guards', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt({
            dialogue: { presence: false, lines: [] },
            audio: undefined,
          }),
          model,
        });

        expect(result).toBe(
          `${fullPromptText}\n\nNo BGM, no music. Generate only dialogue, environmental sounds, and action sounds. Single continuous shot, no cuts.`
        );
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Non-audio models (Grok, MiniMax)
  // ---------------------------------------------------------------------------

  describe('Grok Imagine Video 1.5 (no audio)', () => {
    const model = 'grok_imagine_video_1_5';

    it('returns fullPrompt for non-audio model', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toBe(fullPromptText);
    });
  });

  describe('MiniMax Hailuo 2.3 (no audio)', () => {
    const model = 'minimax_hailuo_02';

    it('returns fullPrompt for non-audio model', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toBe(fullPromptText);
    });
  });

  describe('MiniMax H3 Max (audio, no API switch)', () => {
    const model = 'minimax_h3_max';

    it('tags dialogue as <d>[English] …</d> with speaker and tone in prose', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result.startsWith(fullPromptText)).toBe(true);
      expect(result).toContain(
        'Sarah says in a firm commanding tone: <d>[English] We need to reconsider the entire approach.</d>'
      );
      expect(result).toContain(
        "James says in a soft resigned tone: <d>[English] I couldn't agree more.</d>"
      );
    });

    it('ends with the native soundscape section and non_diegetic_music: N/A', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(
        result.endsWith(
          'overall_soundscape: quiet office hum with keyboard clicks. chair scrape, paper rustling. No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.\nnon_diegetic_music: N/A'
        )
      ).toBe(true);
    });

    it('writes "off" into the prompt when generateAudio is false (no API field)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
        generateAudio: false,
      });

      expect(result).not.toContain('<d>');
      expect(result).toContain(
        'overall_soundscape: Silent. No dialogue, no sound effects, no music.'
      );
      expect(result).toContain('non_diegetic_music: N/A');
    });

    it('still switches music off when the scene has no dialogue or audio data', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: undefined,
          audio: undefined,
        }),
        model,
      });

      expect(result).not.toContain('<d>');
      expect(result).toContain('overall_soundscape: No BGM, no music.');
      expect(result).toContain('non_diegetic_music: N/A');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles dialogue lines without tone', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: {
            presence: true,
            lines: [{ character: 'Sarah', line: 'Hello.', tone: '' }],
          },
        }),
        model: 'kling_v3_pro',
      });

      // No tone → no tone suffix in Kling label
      expect(result).toContain('[Sarah]: "Hello."');
    });

    it('handles narrator (empty character)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: {
            presence: true,
            lines: [
              { character: '', line: 'It was a dark night.', tone: 'somber' },
            ],
          },
        }),
        model: 'kling_v3_pro',
      });

      expect(result).toContain('[Narrator, somber]: "It was a dark night."');
    });

    it('handles audio with only ambient sound', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: 'rain on windows', soundEffects: [] },
        }),
        model: 'veo3_1',
      });

      expect(result).toContain('Audio: rain on windows');
    });

    it('handles audio with only sound effects', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: ['door slam'] },
        }),
        model: 'veo3_1',
      });

      expect(result).toContain('Audio: door slam');
    });

    it('handles empty audio (no ambient, no SFX)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: [] },
        }),
        model: 'veo3_1',
      });

      // Audio: section carries only the no-music direction
      expect(result).toContain(
        'Audio: No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.'
      );
    });

    it('never adds a no-music direction to a model that generates no audio', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model: 'grok_imagine_video_1_5',
      });

      expect(result).not.toContain('No BGM');
    });
  });
});
