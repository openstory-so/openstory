import { describe, expect, it } from 'vitest';
import { asStub } from '@/test/as-stub';
import type { CharacterBibleWireEntry } from '@/sequences/response-schemas';
import { sceneSplitBiblesResultSchema } from '@/sequences/response-schemas';
import {
  bibleFromWire,
  foldLegacyFeatures,
  foldLegacyFeaturesInPayload,
  relabelBibleLooks,
  relabelLookPicks,
  wearBibleLooks,
  withBibleLooks,
  withoutLooks,
  wornLookOnly,
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
      sceneIdForLine,
      30,
      new Map()
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
      sceneIdForLine,
      30,
      new Map()
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
      sceneIdForLine,
      30,
      new Map()
    );
    expect(characterBible[0]?.standardClothing).toBe('jeans');
    expect(characterBible.flatMap((c) => c.looks.map((l) => l.lookId))).toEqual(
      ['a:default', 'a:night', 'a:night_2', 'b:default']
    );
  });

  it('drops a line that is not in the script instead of dressing a scene with it', () => {
    const { sceneLooks } = bibleFromWire(
      [
        {
          ...mia,
          looks: [
            mia.looks[0] ?? { name: '', clothing: '', styling: '', lines: [] },
            {
              name: 'Gala gown',
              clothing: 'red gown',
              styling: '',
              // Only 12 is a line of this 30-line script.
              lines: [0, -4, 12, 12.5, Number.NaN, 31, 99],
            },
          ],
        },
      ],
      sceneIdForLine,
      30,
      new Map()
    );
    expect(sceneLooks).toEqual({ scene_2: { mia: 'char_mia:gala_gown' } });
  });

  it('keeps the analysed clothing when the first look leaves it blank', () => {
    const { characterBible } = bibleFromWire(
      [
        wire({
          characterId: 'char_sam',
          standardClothing: 'grey suit',
          looks: [{ name: 'Default', clothing: '  ', styling: '', lines: [] }],
        }),
      ],
      sceneIdForLine,
      30,
      new Map()
    );
    expect(characterBible[0]).toMatchObject({
      standardClothing: 'grey suit',
      looks: [{ clothing: 'grey suit' }],
    });
  });

  it('numbers a repeated look name, so each name is one look', () => {
    const { characterBible } = bibleFromWire(
      [
        wire({
          characterId: 'a',
          looks: [
            { name: 'Day', clothing: 'jeans', styling: '', lines: [] },
            { name: 'Gala', clothing: 'red', styling: '', lines: [] },
            { name: 'gala', clothing: 'blue', styling: '', lines: [] },
          ],
        }),
      ],
      sceneIdForLine,
      30,
      new Map()
    );
    expect(characterBible[0]?.looks.map((look) => look.name)).toEqual([
      'Day',
      'Gala',
      'gala 2',
    ]);
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
      bibleFromWire(parsed.characterBible, sceneIdForLine, 30, new Map())
        .characterBible[0]?.looks
    ).toHaveLength(1);
  });
});

describe('wearing a look', () => {
  const [entry] = bibleFromWire(
    [mia],
    sceneIdForLine,
    30,
    new Map()
  ).characterBible;
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

  it('shows a shot prompt only the worn look, and a voice prompt none', () => {
    const [dressed] = wearBibleLooks([entry], { mia: 'char_mia:gala_gown' });
    if (!dressed) throw new Error('setup');
    expect(wornLookOnly([dressed])[0]?.looks.map((l) => l.name)).toEqual([
      'Gala gown',
    ]);
    expect(withoutLooks(dressed)).not.toHaveProperty('looks');
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

describe('bibleFromWire with two characters of one tag (#2050)', () => {
  it('numbers the repeat so both keep their own picks, and a reserved tag counts', () => {
    const twin = wire({
      characterId: 'char_002',
      name: 'Mia',
      consistencyTag: 'mia',
      looks: [
        { name: 'Default', clothing: 'jeans', styling: '', lines: [] },
        { name: 'Rain', clothing: 'mac', styling: '', lines: [12] },
      ],
    });
    const { characterBible, sceneLooks } = bibleFromWire(
      [mia, twin, wire({ characterId: 'char_003', consistencyTag: 'sam' })],
      sceneIdForLine,
      30,
      new Map([['char_sam', 'sam']])
    );
    expect(characterBible.map((c) => c.consistencyTag)).toEqual([
      'mia',
      'mia_2',
      'sam_2',
    ]);
    expect(sceneLooks.scene_2).toEqual({
      mia: 'char_mia:gala_gown',
      mia_2: 'char_002:rain',
    });
  });
});

describe('bibleFromWire with an echoed cast character (#2050)', () => {
  it('keeps her own tag whatever the model wrote, and numbers only a new same-named entry', () => {
    const { characterBible } = bibleFromWire(
      [
        wire({
          characterId: 'char_ada',
          name: 'Ada',
          consistencyTag: 'ada_rewritten',
        }),
        wire({ characterId: 'char_009', name: 'Ada', consistencyTag: 'ada' }),
      ],
      sceneIdForLine,
      30,
      new Map([['char_ada', 'ada']])
    );
    expect(characterBible.map((c) => c.consistencyTag)).toEqual([
      'ada',
      'ada_2',
    ]);
  });
});

describe('an entry written before the default look took the features (#2065)', () => {
  // Persisted look ids, as a payload frozen from a cast read carries.
  const office = {
    lookId: '01JZZZZZZZZZZZZZZZZZZZZZZ1',
    name: 'Default',
    clothing: 'suit',
    styling: 'hair up',
  };
  const gala = {
    lookId: '01JZZZZZZZZZZZZZZZZZZZZZZ2',
    name: 'Gala',
    clothing: 'gown',
    styling: 'split lip',
  };
  const old = (looks: unknown[]) => ({
    ...wire({ characterId: 'char_mia' }),
    distinguishingFeatures: 'scar',
    looks,
  });

  it('folds the features into the first look’s styling and drops the key', () => {
    expect(foldLegacyFeatures(old([office, gala]))).toEqual({
      ...wire({ characterId: 'char_mia' }),
      looks: [{ ...office, styling: 'hair up\nscar' }, gala],
    });
    // Blank features only lose the key; the look keeps its own text.
    expect(
      foldLegacyFeatures({ ...old([office]), distinguishingFeatures: '  ' })
    ).toEqual({ ...wire({ characterId: 'char_mia' }), looks: [office] });
    // An entry of the current shape, and one with no looks, come back as is.
    const current = wire({ characterId: 'char_mia' });
    expect(foldLegacyFeatures(current)).toBe(current);
    const noLooks = old([]);
    expect(foldLegacyFeatures(noLooks)).toBe(noLooks);
  });

  it('folds onto the default look of an entry under slug ids, wherever it sits; with no default there, no look takes the text', () => {
    const slug = (lookId: string, styling: string) => ({
      lookId,
      name: lookId,
      clothing: 'x',
      styling,
    });
    const byDefault = slug('char_mia:default', 'hair up');
    const rain = slug('char_mia:rain', 'wet hair');
    // Dressed for a scene that picks the rain look: worn first.
    expect(foldLegacyFeatures(old([rain, byDefault]))).toEqual({
      ...wire({ characterId: 'char_mia' }),
      looks: [rain, { ...byDefault, styling: 'hair up\nscar' }],
    });
    // Only the worn look was frozen: it is not the default, so it reads no
    // features, as a live verify of that look computes.
    expect(foldLegacyFeatures(old([rain]))).toEqual({
      ...wire({ characterId: 'char_mia' }),
      looks: [rain],
    });
    // A wire look has no id yet: the first is the default.
    const { lookId: _a, ...wireDefault } = byDefault;
    const { lookId: _b, ...wireRain } = rain;
    expect(foldLegacyFeatures(old([wireDefault, wireRain]))).toEqual({
      ...wire({ characterId: 'char_mia' }),
      looks: [{ ...wireDefault, styling: 'hair up\nscar' }, wireRain],
    });
  });

  it('4e: a bibles response recorded with the old field still parses, into the default look', () => {
    const { looks: _looks, ...beforeLooks } = wire({ characterId: 'char_old' });
    const parsed = sceneSplitBiblesResultSchema.parse({
      characterBible: [
        { ...beforeLooks, distinguishingFeatures: 'coral lipstick' },
        { ...mia, distinguishingFeatures: 'gold hoops' },
      ],
      locationBible: [],
      elementBible: [],
    });
    const { characterBible } = bibleFromWire(
      parsed.characterBible,
      sceneIdForLine,
      30,
      new Map()
    );
    expect(characterBible[0]).not.toHaveProperty('distinguishingFeatures');
    // Recorded before looks: the default look is made from the clothing,
    // and takes the features.
    expect(characterBible[0]?.looks).toEqual([
      {
        lookId: 'char_old:default',
        name: 'Default',
        clothing: 'office suit',
        styling: 'coral lipstick',
      },
    ]);
    // Recorded with looks: the first is the default, and only it takes them.
    expect(characterBible[1]?.looks.map((look) => look.styling)).toEqual([
      'gold hoops',
      'hair pinned up',
    ]);
  });

  it('4e: a queued payload is folded wherever it carries a bible entry; a talent’s metadata is not', () => {
    const talent = { ...old([office]), characterId: 'talent_1' };
    const payload = {
      userId: 'u',
      teamId: 't',
      characterBible: [old([office, gala])],
      attachedCast: [{ id: 'row', shared: false, entry: old([office]) }],
      plan: { context: { characterBible: [old([office])] } },
      talentMatches: [{ characterId: 'char_mia', sheetMetadata: talent }],
    };
    const folded = foldLegacyFeaturesInPayload(payload);
    const moved = {
      ...wire({ characterId: 'char_mia' }),
      looks: [{ ...office, styling: 'hair up\nscar' }],
    };
    expect(folded.characterBible[0]).toEqual({
      ...moved,
      looks: [...moved.looks, gala],
    });
    expect(folded.attachedCast[0]?.entry).toEqual(moved);
    expect(folded.plan.context.characterBible[0]).toEqual(moved);
    expect(folded.talentMatches[0]?.sheetMetadata).toBe(talent);
    // The current shape comes back equal.
    expect(foldLegacyFeaturesInPayload(folded)).toEqual(folded);
  });

  it('4e: a queued sheet payload keeps its look’s styling beside the entry: the default look takes the features, another look does not', () => {
    const queued = (face: { url: string; versionId: string } | null) => ({
      characterMetadata: old([office]),
      lookStyling: 'hair up' as string | null,
      face,
      talentMetadata: { ...old([office]), characterId: 'talent_1' },
    });
    const parts = { distinguishingFeatures: 'scar', styling: 'hair up' };
    const byDefault = foldLegacyFeaturesInPayload(queued(null));
    expect(byDefault).toMatchObject({
      lookStyling: 'hair up\nscar',
      queuedLegacyStyling: parts,
    });
    expect(byDefault.characterMetadata).not.toHaveProperty(
      'distinguishingFeatures'
    );
    expect(byDefault.talentMetadata.distinguishingFeatures).toBe('scar');
    const other = foldLegacyFeaturesInPayload(
      queued({ url: '/r2/face.png', versionId: 'v1' })
    );
    expect(other).toMatchObject({
      lookStyling: 'hair up',
      queuedLegacyStyling: parts,
    });
    expect(other.characterMetadata).not.toHaveProperty(
      'distinguishingFeatures'
    );
  });
});
