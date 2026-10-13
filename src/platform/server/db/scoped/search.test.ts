/**
 * Search read-boundary tests (#2100). Search reads eight kinds of thing
 * across the whole database, so its filters are the data-leak barrier: a hit
 * must belong to the searching team, and must be live.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { dbSceneId } from '@/shots/scene-id';
import {
  characterBibleVersions,
  characterLooks,
  characterLookVersions,
  characters,
  framePromptVersions,
  frames,
  generatedAssets,
  locationBibleVersions,
  locationLibrary,
  scenes,
  sceneScriptVersions,
  sequenceLocations,
  sequences,
  shotDialogueVersions,
  shotPromptVersions,
  shots,
  shotSpecVersions,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { SEARCH_KINDS } from '@/platform/search';
import { createSearchMethods } from './search';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let client: Client;
let db: Database;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

const spec = (action: string) => ({
  framing: { shotSize: '', angle: '', composition: '', subjectStartState: '' },
  action,
  cameraMovement: { move: '', pacing: '' },
  direction: '',
  soundCue: '',
});

/** A sequence holding one scene, shot and location that all say `word`. */
async function seedSequence(teamId: string, styleId: string, word: string) {
  const ids = {
    sequence: generateId(),
    scene: dbSceneId(generateId()),
    sceneVersion: generateId(),
    shot: generateId(),
    specVersion: generateId(),
    motionVersion: generateId(),
    frame: generateId(),
    imageVersion: generateId(),
    sequenceLocation: generateId(),
    locationVersion: generateId(),
  };
  await db.insert(sequences).values({
    id: ids.sequence,
    teamId,
    styleId,
    title: `Sequence ${word}`,
    script: `A script about a ${word}.`,
  });
  await db.insert(scenes).values({
    id: ids.scene,
    sequenceId: ids.sequence,
    orderIndex: 0,
    selectedScriptVersionId: ids.sceneVersion,
  });
  await db.insert(sceneScriptVersions).values({
    id: ids.sceneVersion,
    sceneId: ids.scene,
    content: { extract: `The ${word} enters.`, dialogue: [] },
    title: `Scene ${word}`,
    source: 'split',
  });
  await db.insert(shots).values({
    id: ids.shot,
    sequenceId: ids.sequence,
    sceneId: ids.scene,
    shotNumber: 1,
    selectedSpecVersionId: ids.specVersion,
    selectedMotionPromptVersionId: ids.motionVersion,
  });
  await db.insert(shotSpecVersions).values({
    id: ids.specVersion,
    shotId: ids.shot,
    spec: spec(`The ${word} runs.`),
    source: 'analysis',
  });
  await db.insert(shotPromptVersions).values({
    id: ids.motionVersion,
    shotId: ids.shot,
    promptType: 'motion',
    text: `Track the ${word}.`,
    source: 'derived',
    usesStartFrame: true,
  });
  await db.insert(frames).values({
    id: ids.frame,
    shotId: ids.shot,
    sequenceId: ids.sequence,
    orderIndex: 0,
    selectedImagePromptVersionId: ids.imageVersion,
  });
  await db.insert(framePromptVersions).values({
    id: ids.imageVersion,
    frameId: ids.frame,
    text: `A ${word} at dusk.`,
    source: 'derived',
  });
  await db.insert(shotDialogueVersions).values({
    shotId: ids.shot,
    lines: [{ character: 'A', line: `Look, a ${word}!`, tone: 'awed' }],
    source: 'prompt',
    selectedAt: new Date(),
  });
  await db.insert(sequenceLocations).values({
    id: ids.sequenceLocation,
    sequenceId: ids.sequence,
    locationId: 'loc_001',
    legacyName: 'unused',
    selectedBibleVersionId: ids.locationVersion,
  });
  await db.insert(locationBibleVersions).values({
    id: ids.locationVersion,
    locationId: ids.sequenceLocation,
    name: `${word} enclosure`,
    source: 'analysis',
  });
  return ids;
}

async function seedCharacter(teamId: string, word: string) {
  const id = generateId();
  const bibleVersion = generateId();
  const lookVersion = generateId();
  await db.insert(characters).values({
    id,
    teamId,
    legacyName: 'unused',
    selectedBibleVersionId: bibleVersion,
  });
  await db.insert(characterBibleVersions).values({
    id: bibleVersion,
    characterId: id,
    name: `Keeper of the ${word}`,
    voiceOnly: false,
    isPerson: true,
    source: 'analysis',
  });
  await db.insert(characterLooks).values({
    id,
    characterId: id,
    isDefault: true,
    sortOrder: 0,
    selectedLookVersionId: lookVersion,
    sheetStatus: 'pending',
  });
  await db.insert(characterLookVersions).values({
    id: lookVersion,
    lookId: id,
    name: 'Default',
    clothing: `${word} print coat`,
    source: 'analysis',
  });
  return { character: id, bibleVersion };
}

async function seedAsset(
  teamId: string,
  userId: string,
  word: string,
  activity: 'image' | 'video',
  source: 'studio' | 'catalog' = 'studio'
) {
  const id = generateId();
  await db.insert(generatedAssets).values({
    id,
    teamId,
    userId,
    provider: 'fal',
    endpointId: 'x',
    activity,
    modelName: 'x',
    source,
    input: { prompt: `A ${word} in studio light` },
  });
  return id;
}

/** A team with one of every searchable kind, each saying `word`. */
async function seedTeam(word: string) {
  const teamId = generateId();
  const userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'S',
      config: {
        artStyle: 'Cinematic',
        colorPalette: ['#000000'],
        lighting: 'Natural',
        cameraWork: 'Standard',
        mood: 'Dramatic',
        referenceFilms: [],
        colorGrading: 'Natural',
      },
    })
    .returning();
  if (!style) throw new Error('seed failed');
  const sequence = await seedSequence(teamId, style.id, word);
  const character = await seedCharacter(teamId, word);
  const libraryLocation = generateId();
  await db
    .insert(locationLibrary)
    .values({ id: libraryLocation, teamId, name: `${word} house` });
  return {
    teamId,
    userId,
    styleId: style.id,
    ...sequence,
    ...character,
    libraryLocation,
    image: await seedAsset(teamId, userId, word, 'image'),
    clip: await seedAsset(teamId, userId, word, 'video'),
  };
}

const find = (teamId: string, query: string) =>
  createSearchMethods(db, teamId).find(query, 50);

describe('search', () => {
  it('returns every kind of the team’s own, and nothing of another team’s', async () => {
    const mine = await seedTeam('zebra');
    const theirs = await seedTeam('zebra');

    const hits = await find(mine.teamId, 'ZEBRA');

    expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(SEARCH_KINDS));
    expect(hits.map((hit) => hit.id).sort()).toEqual(
      [
        mine.sequence,
        mine.scene,
        mine.shot,
        mine.character,
        mine.sequenceLocation,
        mine.libraryLocation,
        mine.image,
        mine.clip,
      ].sort()
    );
    for (const hit of hits) {
      if (hit.sequence) expect(hit.sequence.id).toBe(mine.sequence);
    }
    // The other way round, so the first half cannot pass by seeding order.
    const theirIds = (await find(theirs.teamId, 'zebra')).map((hit) => hit.id);
    expect(theirIds).toContain(theirs.sequence);
    expect(theirIds).not.toContain(mine.sequence);
  });

  it('never reads another team’s text through a stray version pointer', async () => {
    const mine = await seedTeam('heron');
    const theirs = await seedTeam('giraffe');

    // Version pointers have no foreign key. Point each of mine at theirs.
    await db
      .update(scenes)
      .set({ selectedScriptVersionId: theirs.sceneVersion })
      .where(eq(scenes.id, mine.scene));
    await db
      .update(shots)
      .set({
        selectedSpecVersionId: theirs.specVersion,
        selectedMotionPromptVersionId: theirs.motionVersion,
      })
      .where(eq(shots.id, mine.shot));
    await db
      .update(frames)
      .set({ selectedImagePromptVersionId: theirs.imageVersion })
      .where(eq(frames.id, mine.frame));
    await db
      .update(characters)
      .set({ selectedBibleVersionId: theirs.bibleVersion })
      .where(eq(characters.id, mine.character));
    await db
      .update(sequenceLocations)
      .set({ selectedBibleVersionId: theirs.locationVersion })
      .where(eq(sequenceLocations.id, mine.sequenceLocation));

    expect(await find(mine.teamId, 'giraffe')).toEqual([]);
  });

  it('hides archived sequences, deleted rows and non-studio generations', async () => {
    const mine = await seedTeam('otter');
    const archived = await seedSequence(mine.teamId, mine.styleId, 'walrus');
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, archived.sequence));
    await seedAsset(mine.teamId, mine.userId, 'walrus', 'image', 'catalog');
    expect(await find(mine.teamId, 'walrus')).toEqual([]);

    const deletedAt = new Date();
    await db.update(scenes).set({ deletedAt }).where(eq(scenes.id, mine.scene));
    await db.update(shots).set({ deletedAt }).where(eq(shots.id, mine.shot));
    await db
      .update(characters)
      .set({ deletedAt })
      .where(eq(characters.id, mine.character));
    await db
      .update(sequenceLocations)
      .set({ deletedAt })
      .where(eq(sequenceLocations.id, mine.sequenceLocation));

    expect((await find(mine.teamId, 'otter')).map((hit) => hit.kind)).toEqual([
      'sequence',
      'libraryLocation',
      'image',
      'clip',
    ]);
  });
});
