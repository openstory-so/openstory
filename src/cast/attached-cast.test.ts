import { describe, expect, it } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { AttachedCastSnapshot } from '@/platform/server/workflow/types';
import {
  applyAttachedCast,
  castEchoProblem,
  castTags,
  formatCastBlock,
} from './attached-cast';

const entry = (
  over: Partial<CharacterBibleEntry> & Pick<CharacterBibleEntry, 'characterId'>
): CharacterBibleEntry => ({
  name: 'Ada',
  age: '30s',
  gender: 'woman',
  ethnicity: '',
  physicalDescription: 'tall, grey eyes',
  standardClothing: 'coat',
  looks: [
    { lookId: 'look-default', name: 'Default', clothing: 'coat', styling: '' },
  ],
  personality: 'dry',
  movement: 'brisk',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: 'ada',
  ...over,
});

const ada: AttachedCastSnapshot = {
  id: 'row-ada',
  shared: true,
  entry: entry({
    characterId: 'char_ada',
    looks: [
      {
        lookId: 'look-default',
        name: 'Default',
        clothing: 'coat',
        styling: '',
      },
      { lookId: 'look-gala', name: 'Gala', clothing: 'gown', styling: 'updo' },
    ],
  }),
};

describe('formatCastBlock', () => {
  it('is nothing at all with no cast, so the message is as it was', () => {
    expect(formatCastBlock([])).toBe('');
  });

  it('lists each cast character with its id, appearance and look names', () => {
    const block = formatCastBlock([ada]);
    expect(block).toContain('<CAST>');
    expect(block).toContain(
      '- char_ada: Ada — 30s, woman, tall, grey eyes. Looks: "Default" (coat); "Gala" (gown)'
    );
    expect(block.endsWith('</CAST>\n')).toBe(true);
  });
});

describe('applyAttachedCast', () => {
  it('a shared character keeps her pinned bible and looks; a new look is added after them, a known one re-points its picks', () => {
    const model = entry({
      characterId: 'char_ada',
      name: 'ADA (older)',
      physicalDescription: 'rewritten by the model',
      looks: [
        {
          lookId: 'char_ada:default',
          name: 'Default',
          clothing: 'x',
          styling: '',
        },
        { lookId: 'char_ada:gala', name: 'gala', clothing: 'y', styling: '' },
        {
          lookId: 'char_ada:rain',
          name: 'Rain',
          clothing: 'mac',
          styling: 'wet',
        },
      ],
    });
    const { characterBible, sceneLooks } = applyAttachedCast(
      [model],
      { scene_2: { ada: 'char_ada:gala' }, scene_3: { ada: 'char_ada:rain' } },
      [ada]
    );
    expect(characterBible).toEqual([
      {
        ...ada.entry,
        looks: [
          ...ada.entry.looks,
          {
            lookId: 'char_ada:rain',
            name: 'Rain',
            clothing: 'mac',
            styling: 'wet',
          },
        ],
      },
    ]);
    expect(sceneLooks).toEqual({
      scene_2: { ada: 'look-gala' },
      scene_3: { ada: 'char_ada:rain' },
    });
  });

  it('leaves a new character, and one only this sequence holds, as the model wrote them', () => {
    const own = { ...ada, shared: false };
    const model = [
      entry({ characterId: 'char_ada', physicalDescription: 'rewritten' }),
      entry({ characterId: 'char_002', name: 'Bo' }),
    ];
    const { characterBible, sceneLooks } = applyAttachedCast(
      model,
      { scene_1: { bo: 'char_002:default' } },
      [own]
    );
    expect(characterBible).toEqual(model);
    expect(sceneLooks).toEqual({ scene_1: { bo: 'char_002:default' } });
  });
});

describe('castEchoProblem and castTags (#2050)', () => {
  it('passes an echoed cast id with its name, and a new name', () => {
    expect(
      castEchoProblem(
        [
          { characterId: 'char_ada', name: 'ADA' },
          { characterId: 'char_002', name: 'Bo' },
        ],
        [ada]
      )
    ).toBeNull();
  });

  it('refuses a cast id given to someone else', () => {
    expect(
      castEchoProblem([{ characterId: 'char_ada', name: 'Bob' }], [ada])
    ).toContain('gave cast id char_ada (Ada) to "Bob"');
  });

  it("refuses a new entry with a cast character's name", () => {
    expect(
      castEchoProblem([{ characterId: 'char_007', name: 'ada' }], [ada])
    ).toContain(
      'made a new "ada" instead of using the cast character char_ada'
    );
  });

  it('reserves the cast tags for the picks', () => {
    expect([...castTags([ada])]).toEqual([['char_ada', 'ada']]);
  });
});
