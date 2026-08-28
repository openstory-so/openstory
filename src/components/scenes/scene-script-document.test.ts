import { describe, expect, it } from 'vitest';
import {
  buildScriptBlocks,
  unsplitScriptTail,
  type ScriptBlockScene,
} from './scene-script-document';
import { dbSceneId } from '@/lib/db/schema';

function scene(
  id: string,
  orderIndex: number,
  extract?: string
): ScriptBlockScene {
  return {
    id: dbSceneId(id),
    orderIndex,
    title: null,
    script: extract ? { extract, dialogue: [] } : null,
  };
}

describe('buildScriptBlocks', () => {
  it('orders blocks by scene orderIndex and numbers them 1-based', () => {
    const blocks = buildScriptBlocks([
      scene('s2', 1),
      scene('s1', 0),
      scene('s3', 2),
    ]);

    expect(blocks.map((b) => b.sceneId)).toEqual(['s1', 's2', 's3']);
    expect(blocks.map((b) => b.sceneNumber)).toEqual([1, 2, 3]);
  });

  it("reads the scene's selected script version", () => {
    const blocks = buildScriptBlocks([scene('s1', 0, 'Edited copy.')]);

    expect(blocks[0]?.extract).toBe('Edited copy.');
  });

  it('renders an empty string rather than dropping a scene with no script', () => {
    const blocks = buildScriptBlocks([scene('s1', 0)]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.extract).toBe('');
  });
});

describe('unsplitScriptTail', () => {
  const script =
    'INT. ONE\n\nfirst.\n\nEXT. TWO\n\nsecond.\n\nINT. THREE\n\nthird.';

  it('returns the whole script before any scene lands', () => {
    expect(unsplitScriptTail(script, [])).toBe(script);
  });

  it('shrinks to what follows the last split scene', () => {
    expect(
      unsplitScriptTail(script, [
        { extract: 'INT. ONE\n\nfirst.' },
        { extract: 'EXT. TWO\n\nsecond.' },
      ])
    ).toBe('INT. THREE\n\nthird.');
  });

  it('is empty once every scene is split', () => {
    expect(
      unsplitScriptTail(script, [
        { extract: 'INT. ONE\n\nfirst.' },
        { extract: 'EXT. TWO\n\nsecond.' },
        { extract: 'INT. THREE\n\nthird.' },
      ])
    ).toBe('');
  });

  it('skips an extract it cannot find instead of resetting', () => {
    expect(
      unsplitScriptTail(script, [
        { extract: 'INT. ONE\n\nfirst.' },
        { extract: 'edited away' },
        { extract: 'EXT. TWO\n\nsecond.' },
      ])
    ).toBe('INT. THREE\n\nthird.');
  });
});
