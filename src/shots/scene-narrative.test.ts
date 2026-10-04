import { describe, expect, it } from 'vitest';
import { narrativeFieldsChanged } from './scene-narrative';

const scene = (continuity: Record<string, unknown>) => ({
  title: 'T',
  location: 'L',
  timeOfDay: 'DAY',
  storyBeat: 'B',
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub: only the keys under test
  continuity: continuity as never,
});

describe('narrativeFieldsChanged', () => {
  it('a look picked and put back is no change, even once an edit filled the empty tags (#2015)', () => {
    const before = scene({ characterTags: ['steve'], elementTags: null });
    const after = scene({
      characterTags: ['steve'],
      elementTags: null,
      colorPalette: '',
      characterLooks: {},
    });
    expect(narrativeFieldsChanged(before, after)).toEqual([]);
  });

  it('a look pick is a continuity change', () => {
    const before = scene({ characterTags: ['steve'] });
    const after = scene({
      characterTags: ['steve'],
      characterLooks: { steve: 'look-1' },
    });
    expect(narrativeFieldsChanged(before, after)).toEqual(['continuity']);
  });
});
