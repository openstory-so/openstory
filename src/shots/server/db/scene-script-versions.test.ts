import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  sceneScriptVersions,
  scenes,
  sequences,
  styles,
  teams,
} from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import { relations } from '@/platform/server/db/schema/relations';
import { createSceneScriptVersionsMethods } from './scene-script-versions';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let sceneId = dbSceneId('');

const NO_NARRATIVE = {
  title: null,
  location: null,
  timeOfDay: null,
  storyBeat: null,
  continuity: null,
};

async function seedScene(orderIndex = 0) {
  sceneId = dbSceneId(generateId());
  await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex });
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
  teamId = generateId();
  sequenceId = generateId();

  await db
    .insert(teams)
    .values({ id: teamId, name: 'Test Team', slug: `test-${teamId}` });
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

  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'Seq',
    script: 'Full script',
    styleId: style.id,
  });
  await seedScene();
});

describe('sceneScriptVersions.write', () => {
  it('appends a version and repoints the scene selection', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    const version = await methods.write({
      sceneId,
      content: { extract: 'Scene one.', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'split',
    });

    const [scene] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    expect(scene?.selectedScriptVersionId).toBe(version.id);

    const edit = await methods.write({
      sceneId,
      content: { extract: 'Edited scene.', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'edit',
    });
    const [sceneAfterEdit] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    expect(sceneAfterEdit?.selectedScriptVersionId).toBe(edit.id);

    const history = await methods.listByScene(sceneId);
    expect(history).toHaveLength(2);
  });

  it('lists selected scripts in sequence order', async () => {
    const scene2Id = dbSceneId(generateId());
    await db.insert(scenes).values({ id: scene2Id, sequenceId, orderIndex: 1 });

    const methods = createSceneScriptVersionsMethods(db);
    await methods.write({
      sceneId,
      content: { extract: 'Scene one.', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'split',
    });
    await methods.write({
      sceneId: scene2Id,
      content: { extract: 'Scene two.', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'split',
    });

    const rows = await methods.listSelectedBySequence(sequenceId);
    expect(rows.map((r) => r.version.content.extract)).toEqual([
      'Scene one.',
      'Scene two.',
    ]);
  });
});

describe('sceneScriptVersions.seedSplitVersions', () => {
  it('bulk-seeds split versions and repoints selection using scene row ids', async () => {
    const scene2Id = dbSceneId(generateId());
    await db.insert(scenes).values({ id: scene2Id, sequenceId, orderIndex: 1 });

    const methods = createSceneScriptVersionsMethods(db);
    const createdAt = new Date();
    const seeds = [
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative: NO_NARRATIVE,
        createdAt,
      },
      {
        sceneId: scene2Id,
        content: { extract: 'Scene two.', dialogue: [] },
        narrative: NO_NARRATIVE,
        createdAt,
      },
    ];

    const inserted = await methods.seedSplitVersions(seeds);
    expect(inserted).toBe(2);

    for (const seed of seeds) {
      const [scene] = await db
        .select()
        .from(scenes)
        .where(eq(scenes.id, seed.sceneId));
      expect(scene?.selectedScriptVersionId).toBe(seed.sceneId);

      const [version] = await db
        .select()
        .from(sceneScriptVersions)
        .where(eq(sceneScriptVersions.id, seed.sceneId));
      expect(version?.source).toBe('split');
      expect(version?.content.extract).toBe(seed.content.extract);
    }

    const listed = await methods.listSelectedBySequence(sequenceId);
    expect(listed.map((r) => r.version.content.extract)).toEqual([
      'Scene one.',
      'Scene two.',
    ]);
  });

  it('is idempotent on replay', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    const seeds = [
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative: NO_NARRATIVE,
        createdAt: new Date(),
      },
    ];

    expect(await methods.seedSplitVersions(seeds)).toBe(1);
    expect(await methods.seedSplitVersions(seeds)).toBe(0);

    const versions = await db
      .select()
      .from(sceneScriptVersions)
      .where(eq(sceneScriptVersions.sceneId, sceneId));
    expect(versions).toHaveLength(1);
  });
});

describe('sceneScriptVersions.updateSplitContent', () => {
  it('overwrites only the split row, leaving a user revision and the selection alone', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    await methods.seedSplitVersions([
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative: NO_NARRATIVE,
        createdAt: new Date(),
      },
    ]);
    const userVersion = await methods.write({
      sceneId,
      content: { extract: 'Scene one, edited.', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'edit',
    });

    const line = { character: 'Lena', line: 'Steady.', tone: '' };
    await methods.updateSplitContent([
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [line] },
        narrative: NO_NARRATIVE,
      },
    ]);

    const [split] = await db
      .select()
      .from(sceneScriptVersions)
      .where(eq(sceneScriptVersions.id, sceneId));
    expect(split?.content.dialogue).toEqual([line]);

    const [user] = await db
      .select()
      .from(sceneScriptVersions)
      .where(eq(sceneScriptVersions.id, userVersion.id));
    expect(user?.content.dialogue).toEqual([]);

    const [scene] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    expect(scene?.selectedScriptVersionId).toBe(userVersion.id);
  });

  it('throws for a scene with no split row rather than leave it on the preview', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    await expect(
      methods.updateSplitContent([
        {
          sceneId,
          content: { extract: 'x', dialogue: [] },
          narrative: NO_NARRATIVE,
        },
      ])
    ).rejects.toThrow(/updated 0\/1 split versions/);
  });

  it('lands the analysis on a hand-added scene, which has no split row; a replay adds nothing', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    await methods.write({
      sceneId,
      content: { extract: '', dialogue: [] },
      narrative: NO_NARRATIVE,
      source: 'edit',
    });
    const seed = {
      sceneId,
      content: { extract: 'Analysed.', dialogue: [] },
      narrative: { ...NO_NARRATIVE, title: 'Entrance' },
    };

    await methods.updateSplitContent([seed]);
    await methods.updateSplitContent([seed]);

    expect(await methods.getSelected(sceneId)).toMatchObject({
      source: 'split',
      title: 'Entrance',
      content: { extract: 'Analysed.' },
    });
    expect(await methods.listByScene(sceneId)).toHaveLength(2);
  });
});

describe('scene narrative on script versions (#1600)', () => {
  const narrative = {
    title: 'Entrance',
    location: 'INT. OFFICE - DAY',
    timeOfDay: 'day',
    storyBeat: 'introduction',
    continuity: null,
  };

  it('a re-analysis puts its narrative on top of a user-edited script', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    await methods.seedSplitVersions([
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative,
        createdAt: new Date(),
      },
    ]);
    const userVersion = await methods.write({
      sceneId,
      content: { extract: 'Scene one, edited.', dialogue: [] },
      narrative,
      source: 'edit',
    });

    await methods.updateSplitContent([
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative: { ...narrative, timeOfDay: 'night' },
      },
    ]);

    const selected = await methods.getSelected(sceneId);
    expect(selected?.id).not.toBe(userVersion.id);
    expect(selected).toMatchObject({
      source: 'split',
      timeOfDay: 'night',
      content: { extract: 'Scene one, edited.' },
    });
  });

  it('an identical re-analysis narrative appends nothing', async () => {
    const methods = createSceneScriptVersionsMethods(db);
    await methods.seedSplitVersions([
      {
        sceneId,
        content: { extract: 'Scene one.', dialogue: [] },
        narrative,
        createdAt: new Date(),
      },
    ]);
    const userVersion = await methods.write({
      sceneId,
      content: { extract: 'Scene one, edited.', dialogue: [] },
      narrative,
      source: 'edit',
    });
    await methods.updateSplitContent([
      { sceneId, content: { extract: 'Scene one.', dialogue: [] }, narrative },
    ]);
    expect((await methods.getSelected(sceneId))?.id).toBe(userVersion.id);
    expect(await methods.listByScene(sceneId)).toHaveLength(2);
  });
});
