import { describe, expect, it } from 'vitest';
import { asStub } from '@/test/as-stub';
import type { CharacterBibleWireEntry } from '@/sequences/response-schemas';
import { sceneSplitBiblesResultSchema } from '@/sequences/response-schemas';
import {
  bibleFromWire,
  relabelBibleLooks,
  relabelLookPicks,
  wearBibleLooks,
  withBibleLooks,
  wornStyling,
} from './bible-looks';

const wire = (
  overrides: Partial<CharacterBibleWireEntry> & { characterId: string }
): CharacterBibleWireEntry => ({
  name: overrides.characterId,
  age: '',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: 'office suit',
  looks: [],
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: overrides.characterId,
  ...overrides,
});

// Lines 1-9 are scene_1, 10-19 scene_2, 20+ scene_3.
const sceneIdForLine = (line: number) =>
  line < 10 ? 'scene_1' : line < 20 ? 'scene_2' : 'scene_3';

const mia = wire({
  characterId: 'char_mia',
  name: 'Mia',
  consistencyTag: 'mia',
  looks: [
    { name: 'Office', clothing: 'office suit', styling: '', lines: [3] },
    {
      name: 'Gala gown',
      clothing: 'red gown',
      styling: 'hair pinned up',
      lines: [12, 25],
    },
  ],
});

describe('bibleFromWire', () => {
  it('gives each look a slug id and turns its lines into scene picks', () => {
    const { characterBible, sceneLooks } = bibleFromWire(
      [mia, wire({ characterId: 'char_sam' })],
      sceneIdForLine
    );
    expect(characterBible[0]?.looks).toEqual([
      {
        lookId: 'char_mia:default',
        name: 'Office',
        clothing: 'office suit',
        styling: '',
      },
      {
        lookId: 'char_mia:gala_gown',
        name: 'Gala gown',
        clothing: 'red gown',
        styling: 'hair pinned up',
      },
    ]);
    // The default look is what "no pick" means: scene_1 gets no entry even
    // though the default listed a line in it.
    expect(sceneLooks).toEqual({
      scene_2: { mia: 'char_mia:gala_gown' },
      scene_3: { mia: 'char_mia:gala_gown' },
    });
  });

  it('gives a character with no looks a default look from its clothing', () => {
    const { characterBible, sceneLooks } = bibleFromWire(
      [wire({ characterId: 'char_sam', standardClothing: 'overalls' })],
      sceneIdForLine
    );
    expect(characterBible[0]?.looks).toEqual([
      {
        lookId: 'char_sam:default',
        name: 'Default',
        clothing: 'overalls',
        styling: '',
      },
    ]);
    expect(sceneLooks).toEqual({});
  });

  it("takes the default clothing from the first look, and keeps two characters' slugs apart", () => {
    const { characterBible } = bibleFromWire(
      [
        wire({
          characterId: 'a',
          standardClothing: 'stale text',
          looks: [
            { name: 'Day', clothing: 'jeans', styling: '', lines: [] },
            { name: 'Night', clothing: 'robe', styling: '', lines: [] },
            { name: 'night', clothing: 'cape', styling: '', lines: [] },
          ],
        }),
        wire({
          characterId: 'b',
          looks: [{ name: 'Day', clothing: 'suit', styling: '', lines: [] }],
        }),
      ],
      sceneIdForLine
    );
    expect(characterBible[0]?.standardClothing).toBe('jeans');
    expect(characterBible.flatMap((c) => c.looks.map((l) => l.lookId))).toEqual(
      ['a:default', 'a:night', 'a:night_2', 'b:default']
    );
  });

  it('parses a bibles response recorded before looks', () => {
    const { looks: _looks, ...recorded } = wire({ characterId: 'char_old' });
    const parsed = sceneSplitBiblesResultSchema.parse({
      characterBible: [recorded],
      locationBible: [],
      elementBible: [],
    });
    expect(parsed.characterBible[0]?.looks).toEqual([]);
    expect(
      bibleFromWire(parsed.characterBible, sceneIdForLine).characterBible[0]
        ?.looks
    ).toHaveLength(1);
  });
});

describe('wearing a look', () => {
  const [entry] = bibleFromWire([mia], sceneIdForLine).characterBible;
  if (!entry) throw new Error('setup');

  it('puts the look a scene picks first, with its clothing', () => {
    const [dressed] = wearBibleLooks([entry], { mia: 'char_mia:gala_gown' });
    expect(dressed?.standardClothing).toBe('red gown');
    expect(dressed?.looks[0]?.name).toBe('Gala gown');
    expect(wornStyling(dressed ?? entry)).toBe('hair pinned up');
    // Dressing an already-dressed entry changes nothing.
    expect(
      wearBibleLooks(dressed ? [dressed] : [], { mia: 'char_mia:gala_gown' })
    ).toEqual([dressed]);
  });

  it('leaves an entry the scene picks nothing for as it is', () => {
    expect(wearBibleLooks([entry], undefined)).toEqual([entry]);
    expect(wearBibleLooks([entry], { sam: 'char_sam:x' })[0]).toBe(entry);
    expect(wornStyling(entry)).toBe('');
  });

  it('swaps slugs for persisted ids on the entries and the picks', () => {
    const ids = { 'char_mia:default': 'L1', 'char_mia:gala_gown': 'L2' };
    const [relabelled] = relabelBibleLooks([entry], ids);
    expect(relabelled?.looks.map((l) => l.lookId)).toEqual(['L1', 'L2']);
    expect(relabelLookPicks({ mia: 'char_mia:gala_gown' }, ids)).toEqual({
      mia: 'L2',
    });
    expect(
      wearBibleLooks(relabelled ? [relabelled] : [], { mia: 'L2' })[0]
        ?.standardClothing
    ).toBe('red gown');
  });

  it('an entry stored before looks reads as wearing its clothing', () => {
    const { looks: _looks, ...old } = entry;
    // an entry stored before #2015 has no looks key
    const stored = asStub<typeof entry>(old);
    expect(wornStyling(stored)).toBe('');
    expect(withBibleLooks(stored).looks[0]?.clothing).toBe('office suit');
    expect(wearBibleLooks([stored], { mia: 'L2' })[0]).toBe(stored);
  });
});
