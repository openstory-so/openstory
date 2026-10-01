import { describe, expect, it } from 'vitest';
import type { SceneScriptVersion } from '@/platform/server/db/schema';
import { asStub } from '@/test/as-stub';
import { BIBLE_EXCERPT_CHARS, bibleScenes } from './production-bible';

const LIMIT = 3;

const row = (i: number, extract: string) => ({
  sceneId: `scene-${i}`,
  orderIndex: i,
  version: asStub<SceneScriptVersion>({
    id: `v-${i}`,
    content: { extract, dialogue: [] },
    title: `Scene ${i}`,
    location: null,
    timeOfDay: null,
    storyBeat: null,
    continuity: null,
  }),
});

describe('bibleScenes', () => {
  it('keeps ids and the selected version, and marks every cut it makes', () => {
    const long = 'x'.repeat(BIBLE_EXCERPT_CHARS + 1);
    const rows = Array.from({ length: LIMIT + 1 }, (_, i) =>
      row(i, i === 0 ? long : 'short')
    );
    const result = bibleScenes(rows, LIMIT);
    expect(result.scenes).toHaveLength(LIMIT);
    expect(result.totalScenes).toBe(LIMIT + 1);
    expect(result.scenesTruncated).toEqual({ continueWith: 'list_scenes' });
    expect(result.scenes[0]).toMatchObject({
      sceneId: 'scene-0',
      selectedScriptVersionId: 'v-0',
      scriptExcerptTruncated: true,
    });
    expect(result.scenes[0]?.scriptExcerpt).toHaveLength(BIBLE_EXCERPT_CHARS);
    expect(result.scenes[1]).toMatchObject({
      scriptExcerpt: 'short',
      scriptExcerptTruncated: false,
    });
  });

  it('marks nothing when nothing is cut', () => {
    expect(bibleScenes([row(0, 'a')], 1).scenesTruncated).toBeNull();
  });
});
