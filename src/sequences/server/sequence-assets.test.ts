import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import {
  renderSegments,
  scenes,
  sequenceElements,
  sequences,
  shots,
  styles,
  teams,
  user,
  videoVariants,
} from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import { createCharactersMethods } from '@/cast/server/db/characters';
import { createCharacterSheetVariantsMethods } from '@/cast/server/db/character-sheet-variants';
import { createLocationsMethods } from '@/cast/server/db/locations';
import { createLocationSheetVariantsMethods } from '@/cast/server/db/location-sheet-variants';
import { createSequenceElementsMethods } from '@/cast/server/db/sequence-elements';
import { createStylesMethods } from '@/look/server/db/styles';
import { createRenderSegmentsMethods } from '@/motion/server/db/render-segments';
import { createVideoVariantsMethods } from '@/motion/server/db/video-variants';
import { createSequenceVariantsMethods } from '@/audio/server/db/sequence-variants';
import { createFramesMethods } from '@/shots/server/db/frames';
import { createScenesMethods } from '@/shots/server/db/scenes';
import { createShotDialogueMethods } from '@/shots/server/db/shot-dialogue';
import { createShotPromptVersionsMethods } from '@/shots/server/db/shot-prompt-versions';
import { createShotsMethods } from '@/shots/server/db/shots';
import { createFrameVariantsMethods } from '@/stills/server/db/frame-variants';
import { createSequenceExportsMethods } from './db/sequence-exports';
import { createSequencesMethods } from './db/sequences';
import { listSequenceAssets, type SequenceAssetDb } from './sequence-assets';

let closeDb: () => Promise<void>;
let db: Database;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

function reads(teamId: string): SequenceAssetDb {
  return {
    sequences: createSequencesMethods(db, teamId, 'user-1'),
    scenes: createScenesMethods(db),
    shots: createShotsMethods(db),
    frames: createFramesMethods(db),
    frameVariants: createFrameVariantsMethods(db),
    renderSegments: createRenderSegmentsMethods(db),
    videoVariants: createVideoVariantsMethods(db),
    characters: createCharactersMethods(db, teamId),
    characterSheetVariants: createCharacterSheetVariantsMethods(db, teamId),
    locations: createLocationsMethods(db, teamId),
    locationSheetVariants: createLocationSheetVariantsMethods(db, teamId),
    sequenceElements: createSequenceElementsMethods(db),
    shotDialogue: createShotDialogueMethods(db),
    sequenceVariants: createSequenceVariantsMethods(db),
    shotPromptVersions: createShotPromptVersionsMethods(db),
    styles: createStylesMethods(db, teamId, 'user-1'),
    sequenceExports: createSequenceExportsMethods(db),
  };
}

describe('listSequenceAssets', () => {
  it('lists the script, a stored clip and an element, and skips a provider-only url', async () => {
    const teamId = generateId();
    const sequenceId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    const segmentId = generateId();
    const videoId = generateId();
    await db
      .insert(user)
      .values({ id: 'user-1', name: 'U', email: `${teamId}@e.com` });
    await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
    const [style] = await db
      .insert(styles)
      .values({
        teamId,
        name: 'default',
        config: {
          mood: 'neutral',
          artStyle: 'cinematic',
          lighting: 'natural',
          colorPalette: ['#000'],
          cameraWork: 'static',
          referenceFilms: [],
          colorGrading: 'neutral',
        },
        previewUrl: 'https://cdn.example/preview.png',
      })
      .returning();
    if (!style) throw new Error('style');
    await db.insert(sequences).values({
      id: sequenceId,
      teamId,
      title: 'Pilot',
      styleId: style.id,
      script: 'INT. ROOM',
    });
    await db.insert(scenes).values({
      id: dbSceneId(sceneId),
      sequenceId,
      orderIndex: 0,
    });
    await db.insert(renderSegments).values({
      id: segmentId,
      sceneId: dbSceneId(sceneId),
      sequenceId,
      selectedVideoVersionId: videoId,
    });
    await db.insert(shots).values({
      id: shotId,
      sequenceId,
      sceneId: dbSceneId(sceneId),
      shotNumber: 1,
      renderSegmentId: segmentId,
    });
    await db.insert(videoVariants).values({
      id: videoId,
      renderSegmentId: segmentId,
      sequenceId,
      model: 'veo3_1',
      manifest: [
        {
          shotId,
          motionPromptVersionId: null,
          frameVersionId: null,
          usesStartFrame: true,
          durationMs: 3000,
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
      ],
      status: 'completed',
      url: 'https://r2/v.mp4',
      storagePath: `team/${sequenceId}/v.mp4`,
    });
    await db.insert(sequenceElements).values({
      sequenceId,
      uploadedFilename: 'logo.png',
      token: 'LOGO',
      imageUrl: '/r2/team/logo.png',
      imagePath: 'team/logo.png',
    });
    await db.insert(videoVariants).values({
      renderSegmentId: segmentId,
      sequenceId,
      model: 'veo3_1',
      manifest: [
        {
          shotId,
          motionPromptVersionId: null,
          frameVersionId: null,
          usesStartFrame: true,
          durationMs: 1000,
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
      ],
      status: 'failed',
      url: null,
      storagePath: null,
    });

    const selected = await listSequenceAssets(reads(teamId), sequenceId, {
      scope: 'selected',
      includeExports: false,
    });
    expect(selected.assets.map((asset) => asset.relativePath).sort()).toEqual([
      'elements/LOGO.png',
      'script.txt',
      `segments/${videoId}.mp4`,
    ]);
    expect(selected.assets.find((asset) => asset.kind === 'video')?.url).toBe(
      `/r2/team/${sequenceId}/v.mp4?download`
    );
    expect(selected.assets.some((asset) => asset.kind === 'style')).toBe(false);

    await db
      .update(videoVariants)
      .set({ discardedAt: new Date() })
      .where(eq(videoVariants.id, videoId));
    const history = await listSequenceAssets(reads(teamId), sequenceId, {
      scope: 'history',
      includeExports: false,
    });
    expect(history.assets.some((asset) => asset.versionId === videoId)).toBe(
      true
    );
    const current = await listSequenceAssets(reads(teamId), sequenceId, {
      scope: 'selected',
      includeExports: false,
    });
    expect(current.assets.some((asset) => asset.kind === 'video')).toBe(false);
  });
});
