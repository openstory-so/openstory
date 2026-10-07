/**
 * Sheet reuse by hash (#2017) against real SQLite: a second sequence that
 * owes a look's sheet finds the first sequence's finished sheet by (look,
 * model, hash) and points its cast look at that row through the ordinary
 * claim — one row, two pointers, no copy. Anything not finished, or not the
 * same inputs, is not a candidate; an adopt whose claim or row moved is
 * refused, never drawn around.
 */
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import {
  characterSheetVariants,
  characters,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { Database } from '@/platform/server/db/client';
import { characterSheetInputHash } from '@/shots/input-hash';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { createCharacterLooksMethods } from './character-looks';
import { createCharactersMethods } from './characters';

let client: Client;
let db: Database;
let teamId = '';
let episode1 = '';
let episode2 = '';
let characterId = '';

const HASH = characterSheetInputHash('a'.repeat(64));
const OTHER_HASH = characterSheetInputHash('b'.repeat(64));
const MODEL = 'nano_banana_2';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await clearVersionRows(db);
  for (const table of [
    characterSheetVariants,
    characters,
    sequences,
    styles,
    teams,
    user,
  ]) {
    await db.delete(table);
  }
  teamId = generateId();
  const userId = generateId();
  episode1 = generateId();
  episode2 = generateId();
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@x.test' });
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
  if (!style) throw new Error('setup');
  await db.insert(sequences).values([
    { id: episode1, teamId, title: 'Episode 1', styleId: style.id },
    { id: episode2, teamId, title: 'Episode 2', styleId: style.id },
  ]);
  const sam = await chars().create(
    {
      sequenceId: episode1,
      characterId: 'char_001',
      name: 'Sam',
      physicalDescription: 'tall',
      standardClothing: 'grey suit',
      sheetStatus: 'pending',
    },
    { source: 'analysis', createdBy: null }
  );
  characterId = sam.id;
  // Episode 2 casts the same character (#2050's attach, library only).
  await db
    .update(characters)
    .set({ inLibrary: true })
    .where(eq(characters.id, characterId));
  await chars().attach(episode2, characterId, { actorId: null });
});

const chars = () => createCharactersMethods(db, teamId);
const looks = () => createCharacterLooksMethods(db, teamId);
const sheets = () => createCharacterSheetVariantsMethods(db, teamId);

async function castLook(sequenceId: string) {
  const row = await chars().getById(sequenceId, characterId);
  if (!row) throw new Error('character gone');
  return row;
}

/** Claim the default look's sheet in a sequence, the way a trigger does. */
async function claim(sequenceId: string) {
  const row = await castLook(sequenceId);
  const look = row.looks.find((l) => l.id === characterId);
  if (!look) throw new Error('look gone');
  const { versionId } = await looks().claimSheet(
    sequenceId,
    characterId,
    {
      lookVersionId: look.lookVersionId,
      bibleVersionId: row.selectedBibleVersionId,
      talentId: row.talentId,
      // The sequences here are inserted with no style version.
      styleVersionId: null,
    },
    { markGenerating: true }
  );
  return versionId;
}

/** Episode 1 draws and lands a sheet with `hash`; returns the row id. */
async function landInEpisode1(hash = HASH, model = MODEL) {
  const versionId = await claim(episode1);
  const landing = await sheets().promoteIfPending({
    sequenceId: episode1,
    characterId,
    lookId: characterId,
    lookVersionId: null,
    versionId,
    claimed: true,
    url: `/r2/${versionId}.png`,
    storagePath: `${versionId}.png`,
    inputHash: hash,
    bibleVersionId: null,
    model,
    workflowRunId: 'run-1',
  });
  expect(landing).toBe('promoted');
  return versionId;
}

const find = (
  overrides: Partial<
    Parameters<ReturnType<typeof sheets>['findReusable']>[0]
  > = {}
) =>
  sheets().findReusable({
    lookId: characterId,
    model: MODEL,
    inputHash: HASH,
    ...overrides,
  });

describe('findReusable', () => {
  it('finds the finished sheet of the same look, model and hash, from another episode', async () => {
    const landed = await landInEpisode1();
    expect((await find())?.id).toBe(landed);
  });

  it('matches on the look, the model and the hash, never on less', async () => {
    await landInEpisode1();
    expect(await find({ inputHash: OTHER_HASH })).toBeNull();
    expect(await find({ model: 'seedream_v5' })).toBeNull();
    expect(await find({ lookId: generateId() })).toBeNull();
  });

  it('returns the newest match when there are several', async () => {
    await landInEpisode1();
    const newer = await landInEpisode1();
    expect((await find())?.id).toBe(newer);
  });

  it('prefers the row a sequence currently selects over a re-roll it rejected', async () => {
    const kept = await landInEpisode1();
    const rejected = await landInEpisode1();
    expect((await castLook(episode1)).selectedSheetVersionId).toBe(rejected);
    // Episode 1 goes back to the first sheet: the re-roll is history there.
    await sheets().select(episode1, characterId, kept, { actorId: null });
    expect((await find())?.id).toBe(kept);
    // With nothing selecting a match, a history row still serves: same
    // image, same inputs.
    await sheets().select(episode1, characterId, kept, { actorId: null });
    const unrelated = await landInEpisode1(OTHER_HASH);
    expect((await castLook(episode1)).selectedSheetVersionId).toBe(unrelated);
    expect((await find())?.id).toBe(rejected);
  });

  it('skips a discarded, divergent, failed or generating row', async () => {
    const discarded = await landInEpisode1();
    // Select another so the first can be discarded.
    const live = await landInEpisode1();
    await sheets().discard(discarded);
    expect((await find())?.id).toBe(live);

    await db
      .update(characterSheetVariants)
      .set({ divergedAt: new Date() })
      .where(eq(characterSheetVariants.id, live));
    expect(await find()).toBeNull();

    for (const status of ['failed', 'generating'] as const) {
      await db.insert(characterSheetVariants).values({
        characterId,
        lookId: characterId,
        model: MODEL,
        inputHash: HASH,
        url: status === 'failed' ? null : '/r2/mid-flight.png',
        storagePath: status === 'failed' ? null : 'mid-flight.png',
        status,
      });
    }
    expect(await find()).toBeNull();
  });

  it('never crosses teams', async () => {
    await landInEpisode1();
    expect(
      await createCharacterSheetVariantsMethods(db, generateId()).findReusable({
        lookId: characterId,
        model: MODEL,
        inputHash: HASH,
      })
    ).toBeNull();
  });
});

describe('adoptIfPending', () => {
  it('points episode 2 at episode 1 row through its claim: one row, two pointers', async () => {
    const shared = await landInEpisode1();
    const claimId = await claim(episode2);
    expect((await castLook(episode2)).sheetStatus).toBe('generating');

    expect(
      await sheets().adoptIfPending({
        sequenceId: episode2,
        lookId: characterId,
        claimVersionId: claimId,
        sheetVersionId: shared,
        model: MODEL,
        inputHash: HASH,
      })
    ).toBe('adopted');

    const two = await castLook(episode2);
    expect(two.selectedSheetVersionId).toBe(shared);
    expect(two.pendingPromoteSheetVersionId).toBeNull();
    expect(two.sheetStatus).toBe('completed');
    expect(two.sheetImageUrl).toBe(`/r2/${shared}.png`);
    // Reads fresh: the stamped hash is the one the plan computed, which is
    // what `readLookSheetStaleness` compares against a draw's hash now.
    expect(two.sheetInputHash).toBe(HASH);
    // Episode 1 is untouched, and no row was added.
    expect((await castLook(episode1)).selectedSheetVersionId).toBe(shared);
    expect(await db.select().from(characterSheetVariants)).toHaveLength(1);
    // Both strips list it; neither episode may discard it from under the other.
    expect(
      (await sheets().listHistoryByLook(episode2, characterId)).map((r) => r.id)
    ).toEqual([shared]);
    await expect(sheets().discard(shared)).rejects.toThrow(
      'Cannot discard the selected sheet version'
    );
  });

  it('is refused once the claim moved, leaving the newer claim alone', async () => {
    const shared = await landInEpisode1();
    const older = await claim(episode2);
    const newer = await claim(episode2);
    expect(
      await sheets().adoptIfPending({
        sequenceId: episode2,
        lookId: characterId,
        claimVersionId: older,
        sheetVersionId: shared,
        model: MODEL,
        inputHash: HASH,
      })
    ).toBe('refused');
    const two = await castLook(episode2);
    expect(two.selectedSheetVersionId).toBeNull();
    expect(two.pendingPromoteSheetVersionId).toBe(newer);
    expect(two.sheetStatus).toBe('generating');
  });

  it('is refused once the row is no longer what the plan matched', async () => {
    const shared = await landInEpisode1();
    const claimId = await claim(episode2);
    const adopt = (sheetVersionId: string, inputHash = HASH) =>
      sheets().adoptIfPending({
        sequenceId: episode2,
        lookId: characterId,
        claimVersionId: claimId,
        sheetVersionId,
        model: MODEL,
        inputHash,
      });
    // A different hash than the plan matched.
    expect(await adopt(shared, OTHER_HASH)).toBe('refused');
    // The row was discarded after the plan (another sheet took its place).
    const replacement = await landInEpisode1();
    await sheets().discard(shared);
    expect(await adopt(shared)).toBe('refused');
    // The claim is still held: the caller fails it, nothing was adopted.
    expect((await castLook(episode2)).pendingPromoteSheetVersionId).toBe(
      claimId
    );
    expect(await adopt(replacement)).toBe('adopted');
  });
});
