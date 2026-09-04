import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { describe, expect, it } from 'vitest';
import {
  describeCauses,
  levelsFromStaleShots,
  previewLevels,
  shotsLabel,
} from './update-all-dialog';

const shot = (causes: string[]): ShotStaleness => ({
  thumbnail: 'stale',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  causes,
});

describe('describeCauses', () => {
  it('dedupes causes across shots', () => {
    expect(
      describeCauses([shot(['Script', 'Character "Woman"']), shot(['Script'])])
    ).toBe('Changed: Script, Character "Woman"');
  });
  it('null when nothing could be named', () => {
    expect(describeCauses([shot([])])).toBeNull();
  });
});

describe('shotsLabel', () => {
  const numbers = new Map([
    ['a', 2],
    ['b', 3],
    ['c', 4],
  ]);
  it('lists shot numbers', () => {
    expect(shotsLabel(['c', 'a', 'b'], numbers, false)).toBe('shots 2, 3 & 4');
    expect(shotsLabel(['a'], numbers, false)).toBe('shot 2');
  });
  it('shot scope reads "this shot"', () => {
    expect(shotsLabel(['a'], numbers, true)).toBe('this shot');
  });
  it('falls back to a count without numbering', () => {
    expect(shotsLabel(['x', 'y'], undefined, false)).toBe('2 shots');
  });
});

describe('levelsFromStaleShots', () => {
  it('shows prompts + images from client staleness so checkboxes render before the preview (#1432)', () => {
    expect(
      levelsFromStaleShots([
        {
          thumbnail: 'stale',
          visualPrompt: 'stale',
          motionPrompt: 'fresh',
          causes: ['Script'],
        },
      ])
    ).toEqual([
      { depth: 'prompts', label: 'Prompts' },
      { depth: 'images', label: 'Images' },
    ]);
  });

  it('shows images only when the still is stale and prompts are fresh', () => {
    expect(levelsFromStaleShots([shot(['Character "Woman"'])])).toEqual([
      { depth: 'images', label: 'Images' },
    ]);
  });

  it('shows prompts only when motion is stale and the still is not', () => {
    expect(
      levelsFromStaleShots([
        {
          thumbnail: 'fresh',
          visualPrompt: 'fresh',
          motionPrompt: 'stale',
          causes: ['Script'],
        },
      ])
    ).toEqual([{ depth: 'prompts', label: 'Prompts' }]);
  });
});

describe('previewLevels', () => {
  const numbers = new Map([
    ['a', 2],
    ['b', 3],
  ]);
  const preview = {
    visualPromptShotIds: ['a', 'b'],
    motionPromptShotIds: ['b'],
    imageShotIds: ['a', 'b'],
    videoShotIds: [],
    musicPrompt: true,
    musicTrack: false,
    costByLevel: { prompts: null, images: null, video: null, music: null },
  };
  it('lists only levels with work, concretely, in cascade order', () => {
    expect(previewLevels(preview, numbers, false)).toEqual([
      {
        depth: 'prompts',
        label: 'Image prompts for shots 2 & 3 · Motion prompts for shot 3',
      },
      { depth: 'images', label: 'Images for shots 2 & 3' },
      { depth: 'music', label: 'Music prompt' },
    ]);
  });
});
