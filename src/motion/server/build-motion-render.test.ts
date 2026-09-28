import { describe, expect, it } from 'vitest';
import { buildMotionRender } from './build-motion-render';
import type { MotionRenderShot } from './build-motion-render';

const context = { userId: 'user', teamId: 'team', sequenceId: 'sequence' };
const shot = (shotId: string, fullPrompt: string): MotionRenderShot => ({
  shotId,
  sceneId: 'scene',
  referenceOnly: true,
  frameVersionId: null,
  packedScene: {
    location: 'Dock',
    lightingSetup: 'single overhead bulb',
    colorPalette: 'cold blues',
  },
  attachSceneHeader: true,
  model: 'seedance_v2_5',
  duration: 2,
  prompt: 'obsolete preassembled text',
  motionPrompt: {
    fullPrompt,
    dialogue: { presence: false, lines: [] },
    audio: null,
  },
  motionPromptVersionId: `version-${shotId}`,
  characterTags: ['@Ada'],
});

describe('buildMotionRender', () => {
  it('adds scene settings to standalone structured and raw-text shots', () => {
    for (const structured of [true, false]) {
      const input = buildMotionRender({
        ...context,
        shots: [
          {
            ...shot('only', 'The door opens.'),
            attachSceneHeader: false,
            motionPrompt: structured
              ? { fullPrompt: 'The door opens.' }
              : undefined,
            prompt: 'The door opens.',
            model: 'grok_imagine_video_1_5',
          },
        ],
      })[0]?.input;
      expect(input?.prompt).toContain('Dock');
      expect(input?.prompt).toContain('single overhead bulb');
      expect(input?.prompt).toContain('cold blues');
      expect(input?.prompt).toContain('The door opens.');
      expect(input?.attachSceneHeader).toBe(true);
    }
  });

  it('packs siblings once with one scene header and every member version', () => {
    const shots = [
      shot('a', 'opens the door'),
      shot('b', 'runs down the dock'),
    ];
    const jobs = buildMotionRender({ ...context, shots });
    expect(jobs).toHaveLength(1);
    const input = jobs[0]?.input;
    expect(input?.duration).toBe(4);
    expect(input?.prompt).toContain('opens the door');
    expect(input?.prompt).toContain('runs down the dock');
    expect(input?.prompt.split('single overhead bulb')).toHaveLength(2);
    expect(input?.prompt).not.toContain('obsolete');
    expect(
      input?.coveredShots?.map((member) => member.motionPromptVersionId)
    ).toEqual(['version-a', 'version-b']);
  });

  it('keeps the scene header when only one Grok sibling is submitted', () => {
    const jobs = buildMotionRender({
      ...context,
      shots: [shot('a', 'opens the door')],
      videoModels: ['grok_imagine_video_1_5'],
    });
    expect(jobs).toHaveLength(1);
    for (const { input } of jobs)
      expect(input.prompt).toContain('single overhead bulb');
  });

  it('renders edited text with current voiced dialogue, never a stale preassembled prompt (#1836)', () => {
    const edited = shot('a', 'Ada raises her hand');
    edited.motionPrompt = {
      fullPrompt: 'Ada raises her hand',
      dialogue: {
        presence: true,
        lines: [{ character: 'Ada', line: 'The new words', tone: 'quiet' }],
      },
      audio: null,
    };
    const [job] = buildMotionRender({ ...context, shots: [edited] });
    expect(job?.input.prompt).toContain('Ada raises her hand');
    expect(job?.input.prompt).toContain('The new words');
    expect(job?.input.prompt).not.toContain('obsolete');
  });

  it('keeps sticky membership and unions references from later members', () => {
    const a = { ...shot('a', 'opens'), renderSegmentId: 'clip' };
    const b = {
      ...shot('b', 'closes'),
      renderSegmentId: 'clip',
      referenceImages: [
        {
          token: '@Prop',
          referenceImageUrl: 'https://example.com/prop.png',
          description: 'prop',
        },
      ],
    };
    const jobs = buildMotionRender({
      ...context,
      shots: [a, b, { ...shot('c', 'waits'), renderSegmentId: 'other' }],
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.input.coveredShots?.map((member) => member.shotId)).toEqual(
      ['a', 'b']
    );
    expect(jobs[0]?.input.referenceImages).toEqual(b.referenceImages);
  });
});
