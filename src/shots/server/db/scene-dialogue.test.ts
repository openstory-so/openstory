/**
 * Scene dialogue node (#1657): authored versions and recorded takes, against
 * in-memory libSQL with the real migrations.
 *
 * NOTE: `scene_dialogue_versions` / `scene_dialogue_takes` have no migration
 * yet — one is generated for the whole branch at the end — so this file fails
 * until it lands, exactly like `sequence-cast-crud.test.ts` does for
 * `character_voice_versions`.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  sceneDialogueTakes,
  sceneDialogueVersions,
  scenes,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import type {
  DbSceneId,
  MotionAudioClip,
  SceneDialogueLine,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSceneDialogueMethods } from './scene-dialogue';

let client: Client;
let db: Database;
let sequenceId = '';
let sceneId: DbSceneId;
let otherSceneId: DbSceneId;

const line = (shotId: string, text: string): SceneDialogueLine => ({
  character: 'Maya',
  line: text,
  tone: 'calm',
  shotId,
});

const clip = (id: string): MotionAudioClip => ({
  id,
  url: `/r2/audio/${id}.wav`,
  token: 'DIALOGUE',
  durationSeconds: 2,
  sourceKey: 'k',
});

function takeInput(
  overrides: Partial<{ inputHash: string; url: string }> = {}
) {
  return {
    sceneId,
    dialogueVersionId: 'version-1',
    inputHash: 'hash-1',
    url: '/r2/audio/take.wav',
    durationSeconds: 4,
    segments: [
      { lineIndex: 0, shotId: 'shot-1', startSeconds: 0, endSeconds: 2 },
    ],
    clips: { 'shot-1': [clip('slice-1')] },
    characterCount: 42,
    ...overrides,
  };
}

async function seed() {
  await db.delete(sceneDialogueTakes);
  await db.delete(sceneDialogueVersions);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
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
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const inserted = await db
    .insert(scenes)
    .values([
      { sequenceId, orderIndex: 0, title: 'One' },
      { sequenceId, orderIndex: 1, title: 'Two' },
    ])
    .returning();
  const [first, second] = inserted;
  if (!first || !second) throw new Error('test setup: scene insert failed');
  sceneId = first.id;
  otherSceneId = second.id;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('authored versions', () => {
  it('appends and moves the selection, keeping history', async () => {
    const methods = createSceneDialogueMethods(db);
    const first = await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    const second = await methods.write(
      sceneId,
      [line('shot-1', 'B')],
      'user-edit'
    );

    expect(second.id).not.toBe(first.id);
    expect((await methods.getSelected(sceneId))?.id).toBe(second.id);
    const versions = await methods.listVersions(sceneId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.selectedAt)).toHaveLength(1);
  });

  it('appends nothing when the lines have not moved', async () => {
    const methods = createSceneDialogueMethods(db);
    const first = await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    const again = await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    expect(again.id).toBe(first.id);
    expect(await methods.listVersions(sceneId)).toHaveLength(1);
  });

  it('appends when only the shot a line belongs to changed', async () => {
    const methods = createSceneDialogueMethods(db);
    await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    await methods.write(sceneId, [line('shot-2', 'A')], 'user-edit');
    expect(await methods.listVersions(sceneId)).toHaveLength(2);
  });

  it('restores an earlier version without deleting the newer one', async () => {
    const methods = createSceneDialogueMethods(db);
    const first = await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    await methods.write(sceneId, [line('shot-1', 'B')], 'user-edit');

    await methods.selectVersion(sceneId, first.id);
    expect((await methods.getSelected(sceneId))?.id).toBe(first.id);
    expect(await methods.listVersions(sceneId)).toHaveLength(2);
  });

  it('refuses a version id from another scene', async () => {
    const methods = createSceneDialogueMethods(db);
    const other = await methods.write(
      otherSceneId,
      [line('shot-9', 'X')],
      'prompt'
    );
    await expect(methods.selectVersion(sceneId, other.id)).rejects.toThrow(
      /not found/
    );
  });

  it('lists only the scenes of the sequence that have a selected row', async () => {
    const methods = createSceneDialogueMethods(db);
    await methods.write(sceneId, [line('shot-1', 'A')], 'prompt');
    const rows = await methods.getSelectedBySequence(sequenceId);
    expect(rows.map((row) => row.sceneId)).toEqual([sceneId]);
  });
});

describe('recorded takes', () => {
  it('selects the newest take and leaves the previous one listed', async () => {
    const methods = createSceneDialogueMethods(db);
    const first = await methods.appendTake(takeInput());
    const second = await methods.appendTake(
      takeInput({ inputHash: 'hash-2', url: '/r2/audio/take-2.wav' })
    );

    expect((await methods.getSelectedTake(sceneId))?.id).toBe(second.id);
    const takes = await methods.listTakes(sceneId);
    expect(takes.map((take) => take.id)).toContain(first.id);
    expect(takes.filter((take) => take.selectedAt)).toHaveLength(1);
  });

  it('carries the slices so selecting a take can restore them', async () => {
    const methods = createSceneDialogueMethods(db);
    const take = await methods.appendTake(takeInput());
    const stored = await methods.getTakeById(take.id);
    expect(stored?.clips['shot-1']?.[0]?.id).toBe('slice-1');
  });

  it('goes back to an earlier take', async () => {
    const methods = createSceneDialogueMethods(db);
    const first = await methods.appendTake(takeInput());
    await methods.appendTake(takeInput({ inputHash: 'hash-2' }));

    await methods.selectTake(sceneId, first.id);
    expect((await methods.getSelectedTake(sceneId))?.id).toBe(first.id);
  });

  it('drops a discarded take from the list and from the selection', async () => {
    const methods = createSceneDialogueMethods(db);
    const take = await methods.appendTake(takeInput());
    await methods.discardTake(sceneId, take.id);

    expect(await methods.listTakes(sceneId)).toEqual([]);
    expect(await methods.getSelectedTake(sceneId)).toBeNull();
    await expect(methods.selectTake(sceneId, take.id)).rejects.toThrow(
      /discarded/
    );
  });

  it('refuses a take id from another scene', async () => {
    const methods = createSceneDialogueMethods(db);
    const other = await methods.appendTake({
      ...takeInput(),
      sceneId: otherSceneId,
    });
    await expect(methods.selectTake(sceneId, other.id)).rejects.toThrow(
      /not found/
    );
  });

  it('lists the selected take of every scene in the sequence', async () => {
    const methods = createSceneDialogueMethods(db);
    await methods.appendTake(takeInput());
    await methods.appendTake({ ...takeInput(), sceneId: otherSceneId });
    const rows = await methods.getSelectedTakesBySequence(sequenceId);
    expect(rows.map((row) => row.sceneId)).toEqual([sceneId, otherSceneId]);
  });
});
