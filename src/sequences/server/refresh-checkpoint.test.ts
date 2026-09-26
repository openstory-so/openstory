import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import { refreshCheckpointFromCast } from './refresh-checkpoint';

function makeDb(
  selectedPrompts: Map<string, { text: string }>,
  shots: readonly unknown[] = []
) {
  const getSelectedByFrameIds = vi.fn(async (frameIds: string[]) => {
    const selected = new Map<string, { text: string }>();
    for (const frameId of frameIds) {
      const prompt = selectedPrompts.get(frameId);
      if (prompt) selected.set(frameId, prompt);
    }
    return selected;
  });
  const dbStub = {
    characters: { list: vi.fn(async () => []) },
    sequenceLocations: { list: vi.fn(async () => []) },
    sequenceElements: { list: vi.fn(async () => []) },
    shots: { listBySequence: vi.fn(async () => shots) },
    shotDialogue: { getSelectedBySequence: vi.fn(async () => []) },
    shotPromptVersions: {
      getSelectedMotionByShots: vi.fn(async () => new Map()),
    },
    scenes: { listBySequence: vi.fn(async () => []) },
    sceneScriptVersions: { listSelectedBySequence: vi.fn(async () => []) },
    framePromptVersions: { getSelectedByFrameIds },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only the methods this refresh path reads
  const db = dbStub as unknown as ScopedDb;
  return { db, getSelectedByFrameIds };
}

describe('refreshCheckpointFromCast visual prompts', () => {
  it('refreshes each scene from the selected prompt on its scene head frame', async () => {
    const { db, getSelectedByFrameIds } = makeDb(
      new Map([
        ['frame-head', { text: 'Edited scene head prompt' }],
        ['frame-other', { text: 'Edited sibling prompt' }],
        ['frame-two', { text: 'Edited second scene prompt' }],
      ])
    );
    const checkpoint: GenerationCheckpoint = {
      completedStage: 'references',
      shotMapping: [
        {
          analysisSceneId: 'scene-1',
          shotId: 'shot-2',
          frameId: 'frame-other',
          shotNumber: 2,
        },
        {
          analysisSceneId: 'scene-1',
          shotId: 'shot-1',
          frameId: 'frame-head',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'scene-2',
          shotId: 'shot-3',
          frameId: 'frame-two',
          shotNumber: 1,
        },
      ],
      visualPromptBySceneId: {
        'scene-1': 'Original scene one prompt',
        'scene-2': 'Original scene two prompt',
        'scene-3': 'Unchanged prompt',
      },
    };

    const refreshed = await refreshCheckpointFromCast(
      db,
      'sequence-1',
      checkpoint
    );

    expect(getSelectedByFrameIds).toHaveBeenCalledWith([
      'frame-head',
      'frame-two',
    ]);
    expect(refreshed.visualPromptBySceneId).toEqual({
      'scene-1': 'Edited scene head prompt',
      'scene-2': 'Edited second scene prompt',
      'scene-3': 'Unchanged prompt',
    });
    expect(checkpoint.visualPromptBySceneId?.['scene-1']).toBe(
      'Original scene one prompt'
    );
  });

  it('keeps the checkpoint value when the head frame has no selected version', async () => {
    const { db, getSelectedByFrameIds } = makeDb(new Map());
    const checkpoint: GenerationCheckpoint = {
      completedStage: 'references',
      shotMapping: [
        {
          analysisSceneId: 'scene-1',
          shotId: 'shot-1',
          frameId: 'frame-1',
          shotNumber: 1,
        },
      ],
      visualPromptBySceneId: { 'scene-1': 'Original prompt' },
    };

    const refreshed = await refreshCheckpointFromCast(
      db,
      'sequence-1',
      checkpoint
    );

    expect(getSelectedByFrameIds).toHaveBeenCalledWith(['frame-1']);
    expect(refreshed.visualPromptBySceneId).toEqual({
      'scene-1': 'Original prompt',
    });
  });

  it('does not query prompts when no scene has a frame', async () => {
    const { db, getSelectedByFrameIds } = makeDb(new Map());
    const checkpoint: GenerationCheckpoint = {
      completedStage: 'script',
      shotMapping: [
        {
          analysisSceneId: 'scene-1',
          shotId: 'shot-1',
          frameId: null,
          shotNumber: 1,
        },
      ],
      visualPromptBySceneId: { 'scene-1': 'Original prompt' },
    };

    const refreshed = await refreshCheckpointFromCast(
      db,
      'sequence-1',
      checkpoint
    );

    expect(getSelectedByFrameIds).not.toHaveBeenCalled();
    expect(refreshed.visualPromptBySceneId).toEqual({
      'scene-1': 'Original prompt',
    });
  });
});
