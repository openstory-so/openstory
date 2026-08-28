import { describe, expect, it } from 'vitest';
import {
  addLineGutter,
  isExcessivelyRepaired,
  resolveBoundaries,
  sceneIndexForLine,
  sliceScenes,
} from './boundary-split';

const script = [
  'INT. OFFICE - DAY',
  '',
  'Sarah types. “We ship tonight,” she mutters.',
  '',
  'EXT. STREET - NIGHT',
  '',
  'Rain hammers the pavement as Sarah runs.',
  '',
  'INT. CAR - CONTINUOUS',
  '',
  'She slams the door.',
].join('\n');

describe('addLineGutter', () => {
  it('prefixes each line with its 1-based number', () => {
    expect(addLineGutter('a\nb\nc')).toBe('1: a\n2: b\n3: c');
  });
});

describe('resolveBoundaries', () => {
  it('resolves exact quotes to strictly increasing offsets with no repairs', () => {
    const { offsets, kept, dropped, repairs } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 5, quote: 'EXT. STREET - NIGHT' },
      { hintLine: 9, quote: 'INT. CAR - CONTINUOUS' },
    ]);
    expect(offsets).toEqual([
      0,
      script.indexOf('EXT. STREET'),
      script.indexOf('INT. CAR'),
    ]);
    expect(kept).toEqual([0, 1, 2]);
    expect(dropped).toEqual([]);
    expect(repairs).toBe(0);
  });

  it('pins the first boundary to offset 0 even when its quote matches later', () => {
    const { offsets, repairs } = resolveBoundaries(script, [
      { hintLine: 3, quote: 'Sarah types.' },
      { hintLine: 5, quote: 'EXT. STREET - NIGHT' },
    ]);
    expect(offsets[0]).toBe(0);
    // Pin-to-0 is the product rule, not a repair — a 1-scene titled script
    // must not trip isExcessivelyRepaired.
    expect(repairs).toBe(0);
  });

  it('resolves repeated identical quotes to later occurrences via the monotonic cursor', () => {
    const returning = [
      'INT. OFFICE - DAY',
      'Sarah types.',
      'INT. OFFICE - DAY',
      'Sarah returns.',
    ].join('\n');
    const { offsets, dropped } = resolveBoundaries(returning, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 3, quote: 'INT. OFFICE - DAY' },
    ]);
    expect(dropped).toEqual([]);
    expect(offsets).toEqual([0, returning.indexOf('INT. OFFICE - DAY', 1)]);
    const slices = sliceScenes(returning, offsets);
    expect(slices).toHaveLength(2);
    expect(slices[1]?.startsWith('INT. OFFICE - DAY')).toBe(true);
    expect(slices.join('')).toBe(returning);
  });

  it('repairs smart-quote and dash drift via normalized compare', () => {
    const { offsets, repairs } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      // Script has curly quotes; the model emitted straight ones.
      { hintLine: 3, quote: 'Sarah types. "We ship tonight,"' },
    ]);
    expect(offsets).toEqual([0, script.indexOf('Sarah types.')]);
    expect(repairs).toBe(1);
  });

  it('repairs a mangled quote tail via the hint-windowed fuzzy prefix scan', () => {
    const { offsets, repairs } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 7, quote: 'rain hammers the pavement AS THE SCENE SHIFTS' },
    ]);
    expect(offsets).toEqual([0, script.indexOf('Rain hammers')]);
    expect(repairs).toBe(1);
  });

  it('drops an unresolvable boundary', () => {
    const { offsets, kept, dropped } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 5, quote: 'NO SUCH TEXT ANYWHERE, TRULY NOT PRESENT' },
      { hintLine: 9, quote: 'INT. CAR - CONTINUOUS' },
    ]);
    expect(offsets).toEqual([0, script.indexOf('INT. CAR')]);
    expect(kept).toEqual([0, 2]);
    expect(dropped).toEqual([1]);
  });

  it('drops a non-monotonic boundary (quote from earlier text)', () => {
    const { kept, dropped } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 9, quote: 'INT. CAR - CONTINUOUS' },
      // Points back before the previous boundary — must not reorder scenes.
      { hintLine: 5, quote: 'EXT. STREET - NIGHT' },
    ]);
    expect(kept).toEqual([0, 1]);
    expect(dropped).toEqual([2]);
  });

  it('supports mid-line (sub-line) anchors for markdown paragraphs', () => {
    const oneLine = 'First the sun rises. Then the city wakes. Finally rain.';
    const { offsets } = resolveBoundaries(oneLine, [
      { hintLine: 1, quote: 'First the sun rises.' },
      { hintLine: 1, quote: 'Then the city wakes.' },
      { hintLine: 1, quote: 'Finally rain.' },
    ]);
    expect(offsets).toEqual([
      0,
      oneLine.indexOf('Then the city'),
      oneLine.indexOf('Finally rain.'),
    ]);
  });
});

describe('sliceScenes', () => {
  it('produces adjacent slices that reassemble the script byte-for-byte', () => {
    const { offsets } = resolveBoundaries(script, [
      { hintLine: 1, quote: 'INT. OFFICE - DAY' },
      { hintLine: 5, quote: 'EXT. STREET - NIGHT' },
      { hintLine: 9, quote: 'INT. CAR - CONTINUOUS' },
    ]);
    const slices = sliceScenes(script, offsets);
    expect(slices).toHaveLength(3);
    expect(slices.join('')).toBe(script);
  });

  it('returns the whole script as one slice when there are no offsets', () => {
    expect(sliceScenes(script, [])).toEqual([script]);
  });
});

describe('sceneIndexForLine', () => {
  const offsets = [
    0,
    script.indexOf('EXT. STREET'),
    script.indexOf('INT. CAR'),
  ];

  it('maps a gutter line to its owning scene', () => {
    expect(sceneIndexForLine(script, offsets, 1)).toBe(0);
    expect(sceneIndexForLine(script, offsets, 5)).toBe(1);
    expect(sceneIndexForLine(script, offsets, 7)).toBe(1);
    expect(sceneIndexForLine(script, offsets, 11)).toBe(2);
  });

  it('clamps out-of-range lines', () => {
    expect(sceneIndexForLine(script, offsets, 0)).toBe(0);
    expect(sceneIndexForLine(script, offsets, 999)).toBe(2);
  });
});

describe('isExcessivelyRepaired', () => {
  it('flags an empty boundary list', () => {
    expect(
      isExcessivelyRepaired(
        { offsets: [], kept: [], dropped: [], repairs: 0 },
        0
      )
    ).toBe(true);
  });

  it('tolerates a single drop in a large split', () => {
    expect(
      isExcessivelyRepaired(
        { offsets: [0], kept: [0], dropped: [1], repairs: 0 },
        10
      )
    ).toBe(false);
  });

  it('flags heavy dropping', () => {
    expect(
      isExcessivelyRepaired(
        { offsets: [0], kept: [0], dropped: [1, 2, 3, 4], repairs: 0 },
        10
      )
    ).toBe(true);
  });

  it('flags majority-fuzzy resolution', () => {
    expect(
      isExcessivelyRepaired(
        { offsets: [0], kept: [0], dropped: [], repairs: 6 },
        10
      )
    ).toBe(true);
  });
});
