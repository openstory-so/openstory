import { describe, expect, it } from 'vitest';
import type {
  MotionDialogue,
  MotionPrompt,
} from '@/shots/scene-analysis.schema';
import {
  DIALOGUE_CLIP_TOKEN,
  VIDEO_MODEL_VOICE_TOKEN,
} from '@/motion/dialogue-tts';
import {
  assembleMotionPrompt,
  assemblePackedMotionPrompt,
} from './assemble-motion-prompt';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const dialogueWithTone: MotionDialogue = {
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

      it('weaves ambience as prose and marks each effect with <>', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        // Ambience is one continuous bed, so it stays prose; the effects are
        // discrete and separately timed, so each gets ByteDance's `<>` marker.
        expect(result).toContain('quiet office hum with keyboard clicks.');
        expect(result).toContain('<chair scrape> <paper rustling>');
        expect(result).not.toContain('Audio:');
        expect(result).not.toContain('Ambient sounds:');
      });

      it("wraps the spoken words in ByteDance's {} dialogue markers", () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result).toContain(
          'Sarah says in a firm commanding voice: {We need to reconsider the entire approach.}'
        );
        expect(result).toContain(
          "James says in a soft resigned voice: {I couldn't agree more.}"
        );
        // Plain quotes let narrative words either side leak into the take.
        expect(result).not.toContain('says "');
      });

      it('speaks a recorded line once, from the recording', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt({
            dialogue: {
              presence: true,
              lines: dialogueWithTone.lines.map((line, index) =>
                index === 0 ? { ...line, voiceToken: 'SARAH_VOICE' } : line
              ),
            },
          }),
          model,
        });

        // Raw token: `buildReferenceVideoPrompt` swaps it for `@Audio1` when
        // the element rides, or for a description when it cannot.
        expect(result).toContain(
          'Sarah speaks this line exactly as recorded in SARAH_VOICE: {We need to reconsider the entire approach.}'
        );
        // ONE speaking event: a second "says" for the same line invites the
        // model to say it twice, and a tone beside a recording contradicts it.
        expect(
          result.split('We need to reconsider the entire approach.').length - 1
        ).toBe(1);
        expect(result).not.toContain('firm commanding');
        // The unbound line keeps its tone and plain form.
        expect(result).toContain(
          "James says in a soft resigned voice: {I couldn't agree more.}"
        );
      });

      it('treats the conversation clip token as a recording', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt({
            dialogue: {
              presence: true,
              lines: dialogueWithTone.lines.map((line, index) =>
                index === 0
                  ? { ...line, voiceToken: DIALOGUE_CLIP_TOKEN }
                  : line
              ),
            },
          }),
          model,
        });

        expect(result).toContain(
          `Sarah speaks this line exactly as recorded in ${DIALOGUE_CLIP_TOKEN}: {We need to reconsider the entire approach.}`
        );
        expect(result).not.toContain('firm commanding');
      });

      it('does not treat video-model as a recording', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt({
            dialogue: {
              presence: true,
              lines: dialogueWithTone.lines.map((line, index) =>
                index === 0
                  ? { ...line, voiceToken: VIDEO_MODEL_VOICE_TOKEN }
                  : line
              ),
            },
          }),
          model,
        });

        expect(result).toContain(
          'Sarah says in a firm commanding voice: {We need to reconsider the entire approach.}'
        );
        expect(result).not.toContain(VIDEO_MODEL_VOICE_TOKEN);
        expect(result).not.toContain('recorded in');
      });

      it('emits no voice binding when no line has one', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
        });

        expect(result).not.toContain('as recorded in');
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

      it('drops the no-cuts pin when the clip is a packed multi-shot', () => {
        const result = assembleMotionPrompt({
          motionPrompt: makeMotionPrompt(),
          model,
          singleTake: false,
        });

        expect(result).toContain('No BGM, no music.');
        expect(result).not.toContain('Single continuous shot, no cuts.');
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
  // Non-audio models (Grok)
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

  describe('Gemini Omni Flash (oner pin)', () => {
    it('pins a 1-shot clip as a single unbroken scene', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model: 'gemini_omni_flash',
      });
      expect(result).toBe(`${fullPromptText}\n\nSingle unbroken scene.`);
    });

    it('does not pin a packed multi-shot', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model: 'gemini_omni_flash',
        singleTake: false,
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
        model: 'kling_v3_pro',
      });

      expect(result).toContain('Ambient sounds: rain on windows');
    });

    it('handles audio with only sound effects', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: ['door slam'] },
        }),
        model: 'kling_v3_pro',
      });

      expect(result).toContain('Ambient sounds: door slam');
    });

    it('handles empty audio (no ambient, no SFX)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: [] },
        }),
        model: 'kling_v3_pro',
      });

      // Only the no-music direction remains
      expect(result).not.toContain('Ambient sounds:');
      expect(result).toContain(
        'No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.'
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

describe('assemblePackedMotionPrompt', () => {
  const shot = (
    fullPrompt: string,
    durationSeconds: number
  ): {
    durationSeconds: number;
    motionPrompt: MotionPrompt;
  } => ({
    durationSeconds,
    motionPrompt: {
      fullPrompt,
      dialogue: { presence: false, lines: [] },
      audio: { ambientSound: '', soundEffects: [] },
    },
  });

  it('a 1-shot list is the existing single-take Seedance path', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4)],
      model: 'seedance_v2',
    });
    expect(packed.prompt).toContain('Single continuous shot, no cuts.');
    expect(packed.multiPrompt).toBeUndefined();
  });

  it('Seedance 2.0 packs with Shot N prose and cut to, no oner pin', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4), shot('the hallway beyond', 6)],
      model: 'seedance_v2',
    });
    expect(packed.prompt).toContain('Shot 1: opens the door');
    expect(packed.prompt).toContain('cut to');
    expect(packed.prompt).toContain('Shot 2: the hallway beyond');
    expect(packed.prompt).not.toContain('Single continuous shot, no cuts.');
  });

  it('Seedance 2.5 adds timestamps on the packed list', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4), shot('the hallway beyond', 6)],
      model: 'seedance_v2_5',
    });
    expect(packed.prompt).toContain('0-4 seconds: Shot 1:');
    expect(packed.prompt).toContain('4-10 seconds: Shot 2:');
  });

  it('H3 Max uses a timed shot list', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4), shot('the hallway beyond', 6)],
      model: 'minimax_h3_max',
    });
    expect(packed.prompt).toContain('Shot 1 (0-4s):');
    expect(packed.prompt).toContain('Shot 2 (4-10s):');
  });

  it('Kling v3 returns multi_prompt with per-shot durations', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4), shot('the hallway beyond', 6)],
      model: 'kling_v3_pro',
    });
    expect(packed.multiPrompt).toEqual([
      { prompt: expect.stringContaining('opens the door'), duration: '4' },
      {
        prompt: expect.stringContaining('the hallway beyond'),
        duration: '6',
      },
    ]);
  });

  it('Omni Flash packed list has no oner pin', () => {
    const packed = assemblePackedMotionPrompt({
      shots: [shot('opens the door', 4), shot('the hallway beyond', 6)],
      model: 'gemini_omni_flash',
    });
    expect(packed.prompt).toContain('Shot 1: opens the door');
    expect(packed.prompt).toContain('cut to');
    expect(packed.prompt).not.toContain('Single unbroken scene.');
  });
});
