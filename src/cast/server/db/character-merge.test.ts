import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { dbSceneId } from '@/shots/scene-id';
import {
  characterLooks,
  characterSheetVariants,
  characters,
  frames,
  framePromptVersions,
  organization,
  sceneScriptVersions,
  scenes,
  sequences,
  shotDialogueVersions,
  shotPromptVersions,
  shots,
  styles,
  user,
} from '@/platform/server/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCharactersMethods } from './characters';

let closeDb: () => Promise<void>;
let db: Database;
let sequenceId = '';
let organizationId = '';
let actorId = '';

async function seed() {
  await clearVersionRows(db);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(characters);
  await db.delete(styles);
  await db.delete(organization);
  await db.delete(user);
  organizationId = generateId();
  sequenceId = generateId();
  actorId = generateId();
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: `t-${organizationId}` });
  await db
    .insert(user)
    .values({ id: actorId, name: 'U', email: `${actorId}@e.com` });
  const [style] = await db
    .insert(styles)
    .values({
      organizationId,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('style');
  await db.insert(sequences).values({
    id: sequenceId,
    organizationId,
    title: 'S',
    styleId: style.id,
    script: 'MARLOE walks in.',
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(seed);

describe('characters.mergeInto', () => {
  it('re-points this sequence, keeps the winner, and soft-removes the loser', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const winner = await methods.create(
      {
        sequenceId,
        characterId: 'char_marlow',
        name: 'Marlow',
        rendering: 'Photoreal live action',
        consistencyTag: 'marlow',
        isPerson: true,
      },
      { source: 'analysis', createdBy: null }
    );
    const loser = await methods.create(
      {
        sequenceId,
        characterId: 'char_marloe',
        name: 'Marloe',
        rendering: 'Photoreal live action',
        consistencyTag: 'marloe',
        isPerson: false,
      },
      { source: 'analysis', createdBy: null }
    );
    const sheetId = generateId();
    await db.insert(characterSheetVariants).values({
      id: sheetId,
      characterId: loser.id,
      lookId: loser.id,
      model: 'test-model',
      url: '/r2/marloe.png',
      storagePath: 'marloe.png',
      portraitUrl: '/r2/marloe-portrait.png',
      status: 'completed',
    });
    await db
      .update(characterLooks)
      .set({ selectedSheetVersionId: sheetId, sheetStatus: 'completed' })
      .where(eq(characterLooks.id, loser.id));

    const sceneId = dbSceneId(generateId());
    await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex: 0 });
    const [script] = await db
      .insert(sceneScriptVersions)
      .values({
        sceneId,
        content: {
          extract: 'MARLOE walks in.',
          dialogue: [{ character: 'Marloe', line: 'Hello.', tone: 'calm' }],
        },
        continuity: {
          characterTags: ['marloe'],
          characterLooks: { marloe: loser.id },
          environmentTag: '',
          elementTags: [],
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
        source: 'split',
      })
      .returning();
    if (!script) throw new Error('script');
    await db
      .update(scenes)
      .set({ selectedScriptVersionId: script.id })
      .where(eq(scenes.id, sceneId));
    const [shot] = await db
      .insert(shots)
      .values({ sequenceId, sceneId, shotNumber: 1 })
      .returning();
    if (!shot) throw new Error('shot');
    const [motion] = await db
      .insert(shotPromptVersions)
      .values({
        shotId: shot.id,
        promptType: 'motion',
        text: 'MARLOE crosses the room.',
        source: 'ai-generated',
        inputHash: 'hash-before',
      })
      .returning();
    if (!motion) throw new Error('motion');
    await db
      .update(shots)
      .set({ selectedMotionPromptVersionId: motion.id })
      .where(eq(shots.id, shot.id));
    await db.insert(shotDialogueVersions).values({
      shotId: shot.id,
      lines: [{ character: 'Marloe', line: 'Hello.', tone: 'calm' }],
      source: 'prompt',
      selectedAt: new Date(),
    });
    const [frame] = await db
      .insert(frames)
      .values({ shotId: shot.id, sequenceId, orderIndex: 0, role: 'first' })
      .returning();
    if (!frame) throw new Error('frame');
    const [image] = await db
      .insert(framePromptVersions)
      .values({
        frameId: frame.id,
        text: 'MARLOE in the doorway.',
        source: 'ai-generated',
        inputHash: 'hash-before',
      })
      .returning();
    if (!image) throw new Error('image');
    await db
      .update(frames)
      .set({ selectedImagePromptVersionId: image.id })
      .where(eq(frames.id, frame.id));

    const merged = await methods.mergeInto(sequenceId, loser.id, winner.id, {
      actorId,
    });
    expect(merged).toEqual({ characterId: winner.id, sheetCopied: true });

    const loserAfter = await methods.getById(sequenceId, loser.id);
    const winnerAfter = await methods.getById(sequenceId, winner.id);
    expect(loserAfter?.deletedAt).toBeTruthy();
    expect(loserAfter?.isPerson).toBe(false);
    expect(winnerAfter?.name).toBe('Marlow');
    expect(winnerAfter?.isPerson).toBe(true);
    expect(winnerAfter?.sheetImageUrl).toBe('/r2/marloe.png');
    expect(winnerAfter?.deletedAt).toBeNull();

    const [selectedScript] = await db
      .select()
      .from(sceneScriptVersions)
      .innerJoin(
        scenes,
        eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
      )
      .where(eq(scenes.id, sceneId));
    expect(selectedScript?.scene_script_versions.source).toBe('renamed');
    expect(selectedScript?.scene_script_versions.content.extract).toBe(
      'MARLOW walks in.'
    );
    expect(
      selectedScript?.scene_script_versions.continuity?.characterTags
    ).toEqual(['marlow']);
    expect(
      selectedScript?.scene_script_versions.continuity?.characterLooks
    ).toEqual({});

    const [spoken] = await db
      .select()
      .from(shotDialogueVersions)
      .where(
        and(
          eq(shotDialogueVersions.shotId, shot.id),
          isNotNull(shotDialogueVersions.selectedAt)
        )
      );
    expect(spoken?.lines[0]?.character).toBe('Marlow');
    expect(spoken?.source).toBe('user-edit');

    const prompts = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.shotId, shot.id));
    expect(prompts.map((row) => row.text).sort()).toEqual([
      'MARLOE crosses the room.',
      'MARLOW crosses the room.',
    ]);
    expect(prompts.find((row) => row.source === 'renamed')?.inputHash).toBe(
      'hash-before'
    );

    const [sequence] = await db
      .select({ script: sequences.script })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(sequence?.script).toBe('MARLOE walks in.');

    await methods.restore(sequenceId, loser.id, { actorId });
    expect((await methods.getById(sequenceId, loser.id))?.deletedAt).toBeNull();
  });

  it('does not copy a sheet onto a winner that already has one', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const winner = await methods.create(
      {
        sequenceId,
        characterId: 'char_marlow',
        name: 'Marlow',
        rendering: 'Photoreal live action',
      },
      { source: 'analysis', createdBy: null }
    );
    const loser = await methods.create(
      {
        sequenceId,
        characterId: 'char_marloe',
        name: 'Marloe',
        rendering: 'Photoreal live action',
      },
      { source: 'analysis', createdBy: null }
    );
    const winnerSheet = generateId();
    const loserSheet = generateId();
    await db.insert(characterSheetVariants).values([
      {
        id: winnerSheet,
        characterId: winner.id,
        lookId: winner.id,
        model: 'test-model',
        url: '/r2/winner.png',
        status: 'completed',
      },
      {
        id: loserSheet,
        characterId: loser.id,
        lookId: loser.id,
        model: 'test-model',
        url: '/r2/loser.png',
        status: 'completed',
      },
    ]);
    await db
      .update(characterLooks)
      .set({ selectedSheetVersionId: winnerSheet, sheetStatus: 'completed' })
      .where(eq(characterLooks.id, winner.id));
    await db
      .update(characterLooks)
      .set({ selectedSheetVersionId: loserSheet, sheetStatus: 'completed' })
      .where(eq(characterLooks.id, loser.id));

    const merged = await methods.mergeInto(sequenceId, loser.id, winner.id, {
      actorId,
    });
    expect(merged.sheetCopied).toBe(false);
    expect((await methods.getById(sequenceId, winner.id))?.sheetImageUrl).toBe(
      '/r2/winner.png'
    );
  });
});
