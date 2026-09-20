import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import type { Scene } from '@/shots/scene-analysis.schema';
import { snapshotDialogueContinuation } from './dialogue-continuation';

const scene: Scene = {
  sceneId: 'scene_1',
  sceneNumber: 1,
  originalScript: { extract: 'A conversation', dialogue: [] },
  metadata: {
    title: 'Conversation',
    durationSeconds: 5,
    location: '',
    timeOfDay: '',
    storyBeat: '',
  },
  continuity: {
    characterTags: [],
    environmentTag: '',
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
};
const checkpoint: GenerationCheckpoint = {
  completedStage: 'images',
  scenes: [scene, { ...scene, sceneId: 'scene_2', sceneNumber: 2 }],
  // Intentionally different from scene order: arrays must align to work items.
  shotMapping: [
    { analysisSceneId: 'scene_2', shotId: 'shot_2', frameId: 'frame_2' },
    { analysisSceneId: 'scene_1', shotId: 'shot_1', frameId: 'frame_1' },
  ],
};
const dialogue = {
  presence: true,
  lines: [
    {
      character: 'Ada',
      line: 'Edited line',
      tone: '',
      voiceToken: '__video_model__',
    },
  ],
};
function mockDb() {
  const getSelectedMotionByShots = vi.fn(
    async () =>
      new Map([
        [
          'shot_2',
          {
            id: 'prompt_2',
            text: 'Second selected prompt',
            dialogue: null,
            audio: null,
          },
        ],
        [
          'shot_1',
          { id: 'prompt_1', text: 'Edited prompt', dialogue, audio: null },
        ],
      ])
  );
  const listBySequence = vi.fn(async () => [
    { id: 'shot_1' },
    { id: 'shot_2' },
  ]);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the selected asset reads are exercised
  const db = {
    shots: { listBySequence },
    frames: {
      getAnchorsByShots: vi.fn(
        async () =>
          new Map([
            ['shot_2', { id: 'frame_2' }],
            ['shot_1', { id: 'frame_1' }],
          ])
      ),
    },
    frameVariants: {
      getSelectedByFrameIds: vi.fn(
        async () =>
          new Map([
            ['frame_2', { id: 'image_2', url: '/second.png' }],
            ['frame_1', { id: 'image_1', url: '/edited.png' }],
          ])
      ),
    },
    shotPromptVersions: { getSelectedMotionByShots },
  } as unknown as ScopedDb;
  return { db, getSelectedMotionByShots, listBySequence };
}

describe('snapshotDialogueContinuation', () => {
  it.each([false, true])(
    'excludes deleted shots and keeps surviving inputs aligned (same scene: %s)',
    async (sameScene) => {
      const { db, listBySequence, getSelectedMotionByShots } = mockDb();
      listBySequence.mockResolvedValue([{ id: 'shot_2' }]);
      const original: GenerationCheckpoint = {
        ...checkpoint,
        ...(sameScene
          ? {
              scenes: [scene],
              shotMapping: checkpoint.shotMapping?.map((shot, index) => ({
                ...shot,
                analysisSceneId: scene.sceneId,
                shotNumber: index === 0 ? 2 : 1,
              })),
            }
          : {}),
        dialogueClipsByShotId: { shot_1: [], shot_2: [] },
      };
      const snapshot = await snapshotDialogueContinuation(
        db,
        { id: 'seq_1', musicPrompt: null, musicTags: null },
        original
      );
      expect(listBySequence).toHaveBeenCalledWith('seq_1');
      expect(db.frames.getAnchorsByShots).toHaveBeenCalledWith(['shot_2']);
      expect(getSelectedMotionByShots).toHaveBeenCalledWith(['shot_2']);
      expect(snapshot.shotMapping?.map((shot) => shot.shotId)).toEqual([
        'shot_2',
      ]);
      expect(snapshot.scenes?.map((scene) => scene.sceneId)).toEqual([
        sameScene ? 'scene_1' : 'scene_2',
      ]);
      expect(snapshot.imageStage?.prompts.completeScenes).toEqual(
        snapshot.scenes
      );
      expect(snapshot.imageStage?.images).toEqual({
        imageUrls: ['/second.png'],
        frameVersionIds: ['image_2'],
      });
      expect(
        Object.keys(snapshot.imageStage?.prompts.motionPromptsByShotId ?? {})
      ).toEqual(['shot_2']);
      expect(snapshot.dialogueClipsByShotId).toEqual({ shot_2: [] });
      expect(original.shotMapping).toHaveLength(2);
    }
  );

  it('refuses continuation when every checkpoint shot has been deleted', async () => {
    const { db, listBySequence, getSelectedMotionByShots } = mockDb();
    listBySequence.mockResolvedValue([]);
    await expect(
      snapshotDialogueContinuation(
        db,
        { id: 'seq_1', musicPrompt: null, musicTags: null },
        checkpoint
      )
    ).rejects.toThrow('no remaining shots');
    expect(getSelectedMotionByShots).not.toHaveBeenCalled();
  });

  it('pins selected stills and prompts in clip order, including edits and voice bindings', async () => {
    const { db } = mockDb();
    const snapshot = await snapshotDialogueContinuation(
      db,
      { id: 'seq_1', musicPrompt: 'Edited music', musicTags: 'ambient' },
      checkpoint
    );
    expect(snapshot.imageStage?.images).toEqual({
      imageUrls: ['/edited.png', '/second.png'],
      frameVersionIds: ['image_1', 'image_2'],
    });
    expect(snapshot.imageStage?.prompts).toMatchObject({
      motionPromptsByShotId: {
        shot_1: { fullPrompt: 'Edited prompt', dialogue },
      },
      motionPromptVersionIdsByShotId: {
        shot_1: 'prompt_1',
        shot_2: 'prompt_2',
      },
      musicPrompt: 'Edited music',
      musicTags: 'ambient',
    });
    expect(
      snapshot.imageStage?.prompts.motionPromptsByShotId?.shot_2?.dialogue
    ).toEqual({
      presence: false,
      lines: [],
    });
  });

  it('refuses missing selected prompts instead of silently regenerating them', async () => {
    const { db, getSelectedMotionByShots } = mockDb();
    getSelectedMotionByShots.mockResolvedValue(new Map());
    await expect(
      snapshotDialogueContinuation(
        db,
        { id: 'seq_1', musicPrompt: null, musicTags: null },
        checkpoint
      )
    ).rejects.toThrow('needs a motion prompt');
  });
});
