/**
 * Search read-boundary tests (#2100). Search reads eight kinds of thing
 * across the whole database, so its filters are the data-leak barrier: a hit
 * must belong to the searching organization, and must be live.
 */

import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
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
  locations,
  scenes,
  sceneScriptVersions,
  sequenceLocationLinks,
  sequences,
  shotDialogueVersions,
  shotPromptVersions,
  shots,
  shotSpecVersions,
  styles,
  organization,
  user,
} from '@/platform/server/db/schema';
import { SEARCH_KINDS } from '@/platform/search';
import { createSearchMethods } from './search';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let closeDb: () => Promise<void>;
let db: Database;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

const spec = (action: string) => ({
  framing: { shotSize: '', angle: '', composition: '', subjectStartState: '' },
  action,
  cameraMovement: { move: '', pacing: '' },
  direction: '',
  soundCue: '',
});

/** A sequence holding one scene, shot and location that all say `word`. */
async function seedSequence(
  organizationId: string,
  styleId: string,
  word: string
) {
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
    organizationId,
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
  await db.insert(locations).values({
    id: ids.sequenceLocation,
    organizationId,
    legacyName: 'unused',
    selectedBibleVersionId: ids.locationVersion,
  });
  await db.insert(sequenceLocationLinks).values({
    sequenceId: ids.sequence,
    locationId: ids.sequenceLocation,
    scriptLocationId: 'loc_001',
    attached: false,
  });
  await db.insert(locationBibleVersions).values({
    id: ids.locationVersion,
    locationId: ids.sequenceLocation,
    name: `${word} enclosure`,
    source: 'analysis',
  });
  return ids;
}

async function seedCharacter(organizationId: string, word: string) {
  const id = generateId();
  const bibleVersion = generateId();
  const lookVersion = generateId();
  await db.insert(characters).values({
    id,
    organizationId,
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
  organizationId: string,
  userId: string,
  word: string,
  activity: 'image' | 'video',
  source: 'studio' | 'catalog' = 'studio'
) {
  const id = generateId();
  await db.insert(generatedAssets).values({
    id,
    organizationId,
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

/** An organization with one of every searchable kind, each saying `word`. */
async function seedOrganization(word: string) {
  const organizationId = generateId();
  const userId = generateId();
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: organizationId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  const [style] = await db
    .insert(styles)
    .values({
      organizationId,
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
  const sequence = await seedSequence(organizationId, style.id, word);
  const character = await seedCharacter(organizationId, word);
  const libraryLocation = generateId();
  await db.insert(locations).values({
    id: libraryLocation,
    organizationId,
    legacyName: `${word} house`,
  });
  return {
    organizationId,
    userId,
    styleId: style.id,
    ...sequence,
    ...character,
    libraryLocation,
    image: await seedAsset(organizationId, userId, word, 'image'),
    clip: await seedAsset(organizationId, userId, word, 'video'),
  };
}

const find = (organizationId: string, query: string) =>
  createSearchMethods(db, organizationId).find(query, 50);

describe('search', () => {
  it('returns every kind of the organization’s own, and nothing of another organization’s', async () => {
    const mine = await seedOrganization('zebra');
    const theirs = await seedOrganization('zebra');

    const hits = await find(mine.organizationId, 'ZEBRA');

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
    const theirIds = (await find(theirs.organizationId, 'zebra')).map(
      (hit) => hit.id
    );
    expect(theirIds).toContain(theirs.sequence);
    expect(theirIds).not.toContain(mine.sequence);
  });

  it('never reads another organization’s text through a stray version pointer', async () => {
    const mine = await seedOrganization('heron');
    const theirs = await seedOrganization('giraffe');

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
      .update(locations)
      .set({ selectedBibleVersionId: theirs.locationVersion })
      .where(eq(locations.id, mine.sequenceLocation));

    expect(await find(mine.organizationId, 'giraffe')).toEqual([]);
  });

  it('hides archived sequences, deleted rows and non-studio generations', async () => {
    const mine = await seedOrganization('otter');
    const archived = await seedSequence(
      mine.organizationId,
      mine.styleId,
      'walrus'
    );
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, archived.sequence));
    await seedAsset(
      mine.organizationId,
      mine.userId,
      'walrus',
      'image',
      'catalog'
    );
    expect(await find(mine.organizationId, 'walrus')).toEqual([]);

    const deletedAt = new Date();
    await db.update(scenes).set({ deletedAt }).where(eq(scenes.id, mine.scene));
    await db.update(shots).set({ deletedAt }).where(eq(shots.id, mine.shot));
    await db
      .update(characters)
      .set({ deletedAt })
      .where(eq(characters.id, mine.character));
    await db
      .update(locations)
      .set({ deletedAt })
      .where(eq(locations.id, mine.sequenceLocation));

    expect(
      (await find(mine.organizationId, 'otter')).map((hit) => hit.kind)
    ).toEqual(['sequence', 'libraryLocation', 'image', 'clip']);
  });
});
