/**
 * Sheet claims (#1113) against real SQLite: the trigger claims, every input
 * edit or user pick demotes, completion promotes only while the claim holds
 * and otherwise parks, and a failure clears only its own claim.
 */
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  sequenceCast,
  sequenceCastLooks,
  characterSheetVariants,
  characters,
  sceneScriptVersions,
  scenes,
  locationLibrary,
  locationSheetVariants,
  sequenceLocations,
  sequences,
  styles,
  talent,
  talentSheets,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { NewCharacter } from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import {
  characterSheetInputHash,
  libraryLocationReferenceInputHash,
  locationSheetInputHash,
  talentSheetInputHash,
} from '@/shots/input-hash';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { createCharacterLooksMethods } from './character-looks';
import { createCharactersMethods } from './characters';
import { createLocationsMethods } from './location-library';
import { createLocationSheetVariantsMethods } from './location-sheet-variants';
import { createSequenceLocationsMethods } from './sequence-locations';
import { demoteSequenceSheetClaims } from './sheet-claims';
import { createTalentMethods } from './talent';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';
let sequenceId = '';
let characterId = '';
let locationId = '';
let libraryId = '';
let talentId = '';

const HASH = characterSheetInputHash('a'.repeat(64));
const LOC_HASH = locationSheetInputHash('b'.repeat(64));

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
    locationSheetVariants,
    talentSheets,
    characters,
    sequenceLocations,
    locationLibrary,
    talent,
    sequences,
    styles,
    teams,
    user,
  ]) {
    await db.delete(table);
  }
  teamId = generateId();
  userId = generateId();
  sequenceId = generateId();
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
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const [lib] = await db
    .insert(locationLibrary)
    .values({ teamId, name: 'Diner' })
    .returning();
  const [tal] = await db
    .insert(talent)
    .values({ teamId, name: 'Ada' })
    .returning();
  if (!lib || !tal) throw new Error('setup');
  libraryId = lib.id;
  talentId = tal.id;
  const ch = await createCharactersMethods(db, teamId).create(
    {
      sequenceId,
      characterId: 'char_001',
      name: 'Sam',
      physicalDescription: 'tall',
      standardClothing: 'grey suit',
      sheetStatus: 'pending',
      talentId,
    },
    { source: 'analysis', createdBy: null }
  );
  const loc = await createSequenceLocationsMethods(db).create(
    {
      sequenceId,
      locationId: 'loc_001',
      name: 'Diner',
      libraryLocationId: libraryId,
    },
    { source: 'analysis', createdBy: null }
  );
  characterId = ch.id;
  locationId = loc.id;
});

const chars = () => createCharactersMethods(db, teamId);
const castWith = (to: string | null) =>
  chars().updateBible(
    sequenceId,
    characterId,
    {},
    { actorId: null, source: 'recast', talentId: to }
  );
const looks = () => createCharacterLooksMethods(db, teamId);
const charVersions = () => createCharacterSheetVariantsMethods(db, teamId);
const locs = () => createSequenceLocationsMethods(db);
const locVersions = () => createLocationSheetVariantsMethods(db);
const library = () => createLocationsMethods(db, teamId, userId);
const talents = () => createTalentMethods(db, teamId, userId);

async function character() {
  const row = await chars().getById(sequenceId, characterId);
  if (!row) throw new Error('character gone');
  return row;
}

/** The snapshot a trigger would take of a look, read live. */
async function snapshotOf(lookId: string) {
  const row = await character();
  const look = row.looks.find((l) => l.id === lookId);
  if (!look) throw new Error('look gone');
  return {
    lookVersionId: look.lookVersionId,
    bibleVersionId: row.selectedBibleVersionId,
    talentId: row.talentId,
  };
}

/** Claim a look's sheet the way a trigger does; the default look by default. */
async function claim(lookId = characterId) {
  const { versionId } = await looks().claimSheet(
    sequenceId,
    lookId,
    await snapshotOf(lookId),
    { markGenerating: true }
  );
  return versionId;
}

async function version(id: string) {
  const [row] = await db
    .select()
    .from(characterSheetVariants)
    .where(eq(characterSheetVariants.id, id));
  return row;
}

const landCharacter = (
  versionId: string,
  url = `/r2/${versionId}.png`,
  bibleVersionId: string | null = null,
  claimed = true,
  lookId = characterId
) =>
  charVersions().promoteIfPending({
    sequenceId,
    characterId,
    lookId,
    lookVersionId: null,
    versionId,
    claimed,
    url,
    storagePath: url,
    inputHash: HASH,
    bibleVersionId,
    model: 'm',
    workflowRunId: `run-${versionId}`,
  });

describe('character sheet claims', () => {
  it('lands a run that still holds its claim', async () => {
    const versionId = await claim();
    expect((await character()).sheetStatus).toBe('generating');

    expect(await landCharacter(versionId)).toBe('promoted');
    const row = await character();
    expect(row.selectedSheetVersionId).toBe(versionId);
    expect(row.pendingPromoteSheetVersionId).toBeNull();
    expect(row.sheetStatus).toBe('completed');
    expect((await version(versionId))?.divergedAt).toBeNull();
  });

  it('stamps the bible version the run read on its sheet row (#1600)', async () => {
    const bibleVersionId = (await character()).selectedBibleVersionId;
    expect(bibleVersionId).not.toBeNull();
    const versionId = await claim();
    await landCharacter(versionId, undefined, bibleVersionId);
    expect((await version(versionId))?.bibleVersionId).toBe(bibleVersionId);
  });

  it('parks a run whose bible was edited mid-flight, leaving the live sheet', async () => {
    const first = await claim();
    await landCharacter(first);

    const second = await claim();
    await chars().updateBible(
      sequenceId,
      characterId,
      { physicalDescription: 'short' },
      { source: 'edit', actorId: userId }
    );

    expect(await landCharacter(second)).toBe('parked');
    const row = await character();
    expect(row.selectedSheetVersionId).toBe(first);
    expect(row.sheetStatus).toBe('completed');
    expect((await version(second))?.divergedAt).not.toBeNull();
  });

  it('keeps the claim when the edit touches no field the sheet reads', async () => {
    const versionId = await claim();
    await chars().updateBible(
      sequenceId,
      characterId,
      { personality: 'wry', physicalDescription: 'tall' },
      { source: 'edit', actorId: userId }
    );
    expect(await landCharacter(versionId)).toBe('promoted');
  });

  it('lets a newer kickoff win over a late completion', async () => {
    const older = await claim();
    const newer = await claim();

    expect(await landCharacter(older)).toBe('parked');
    let row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');

    expect(await landCharacter(newer)).toBe('promoted');
    row = await character();
    expect(row.selectedSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('completed');
  });

  it('lands a run queued before #1113 while no run holds a claim', async () => {
    expect(await landCharacter('pre-1113', undefined, null, false)).toBe(
      'promoted'
    );
    expect((await character()).selectedSheetVersionId).toBe('pre-1113');
  });

  it('parks a run queued before #1113 behind a newer claim, keeping it', async () => {
    const newer = await claim();

    expect(await landCharacter('pre-1113', undefined, null, false)).toBe(
      'parked'
    );
    let row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');
    expect((await version('pre-1113'))?.divergedAt).not.toBeNull();

    await looks().failSheetClaim(
      sequenceId,
      characterId,
      null,
      'pre-1113 boom'
    );
    row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');

    expect(await landCharacter(newer)).toBe('promoted');
  });

  it('clears only its own claim when it fails', async () => {
    const older = await claim();
    const newer = await claim();

    await looks().failSheetClaim(sequenceId, characterId, older, 'boom');
    let row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');

    await looks().failSheetClaim(sequenceId, characterId, newer, 'boom');
    row = await character();
    expect(row.pendingPromoteSheetVersionId).toBeNull();
    expect(row.sheetStatus).toBe('failed');
  });

  it('is retry-safe: landing twice promotes once', async () => {
    const versionId = await claim();
    expect(await landCharacter(versionId)).toBe('promoted');
    expect(await landCharacter(versionId)).toBe('promoted');
    const rows = await db
      .select()
      .from(characterSheetVariants)
      .where(eq(characterSheetVariants.characterId, characterId));
    expect(rows).toHaveLength(1);
  });

  it("parks behind the user's pick of another sheet", async () => {
    const first = await claim();
    await landCharacter(first);
    const second = await claim();
    await charVersions().select(sequenceId, characterId, first, {
      actorId: userId,
    });
    expect(await landCharacter(second)).toBe('parked');
  });

  it('does not collide with an identical parked twin', async () => {
    const a = await claim();
    const b = await claim();
    const c = await claim();
    expect(await landCharacter(a)).toBe('parked');
    // Same (character, model, hash) as `a`: stays plain history, no throw.
    expect(await landCharacter(b)).toBe('parked');
    expect((await version(b))?.divergedAt).toBeNull();
    expect(await landCharacter(c)).toBe('promoted');
  });

  it('is revoked by a recast and by a change to the cast talent', async () => {
    let versionId = await claim();
    await castWith(talentId);
    expect(await landCharacter(versionId)).toBe('parked');

    versionId = await claim();
    // A new reference sheet landing on the talent (#2018).
    const newSheet = generateId();
    await talents().claimSheet(
      talentId,
      newSheet,
      { description: null, referenceImageUrls: [] },
      { onlyIfFree: false }
    );
    await talents().landSheet({
      sheetId: newSheet,
      talentId,
      imageUrl: '/r2/look.png',
      imagePath: 'look.png',
      metadata: undefined,
      source: 'manual_upload',
      inputHash: null,
    });
    expect(await landCharacter(versionId)).toBe('parked');

    versionId = await claim();
    // The user picking another sheet from the history (#2018).
    const picked = generateId();
    await talents().claimSheet(
      talentId,
      picked,
      { description: null, referenceImageUrls: [] },
      { onlyIfFree: false }
    );
    await talents().landSheet({
      sheetId: picked,
      talentId,
      imageUrl: '/r2/picked.png',
      imagePath: 'picked.png',
      metadata: undefined,
      source: 'manual_upload',
      inputHash: null,
    });
    versionId = await claim();
    await talents().selectSheet(talentId, newSheet);
    expect(await landCharacter(versionId)).toBe('parked');

    versionId = await claim();
    await talents().update(talentId, { description: 'older now' });
    expect(await landCharacter(versionId)).toBe('parked');
  });

  it('is revoked by a style change on the sequence', async () => {
    const versionId = await claim();
    await db.batch(demoteSequenceSheetClaims(db, sequenceId, sql`1`));
    expect(await landCharacter(versionId)).toBe('parked');
  });
});

describe('look sheet claims (#2015)', () => {
  const addLook = () =>
    looks().create(
      sequenceId,
      characterId,
      { name: 'Gala gown', clothing: 'red gown', styling: null },
      { source: 'edit', actorId: userId }
    );
  const lookOf = async (lookId: string) => {
    const look = (await character()).looks.find((l) => l.id === lookId);
    if (!look) throw new Error('look gone');
    return look;
  };

  it("gives a new character a default look under the character's own id", async () => {
    const row = await character();
    expect(row.lookId).toBe(characterId);
    expect(row.standardClothing).toBe('grey suit');
    expect(row.looks).toMatchObject([
      { id: characterId, isDefault: true, clothing: 'grey suit' },
    ]);
  });

  it('lands each look on its own pointer', async () => {
    const gala = await addLook();
    const galaRun = await claim(gala.id);
    const defaultRun = await claim();

    expect(await landCharacter(galaRun, undefined, null, true, gala.id)).toBe(
      'promoted'
    );
    // The default look's run is untouched by the other look landing.
    expect((await character()).pendingPromoteSheetVersionId).toBe(defaultRun);
    expect((await lookOf(gala.id)).selectedSheetVersionId).toBe(galaRun);
    expect((await version(galaRun))?.lookId).toBe(gala.id);

    expect(await landCharacter(defaultRun)).toBe('promoted');
    expect((await character()).selectedSheetVersionId).toBe(defaultRun);
  });

  it('is revoked by an edit to the look, and only that look', async () => {
    const gala = await addLook();
    const galaRun = await claim(gala.id);
    const defaultRun = await claim();

    await looks().update(
      sequenceId,
      gala.id,
      { clothing: 'blue gown' },
      { source: 'edit', actorId: userId }
    );
    expect(await landCharacter(galaRun, undefined, null, true, gala.id)).toBe(
      'parked'
    );
    expect((await version(galaRun))?.divergedAt).not.toBeNull();
    expect(await landCharacter(defaultRun)).toBe('promoted');
  });

  it('keeps the claim through a rename', async () => {
    const gala = await addLook();
    const run = await claim(gala.id);
    await looks().update(
      sequenceId,
      gala.id,
      { name: 'Gala' },
      { source: 'edit', actorId: userId }
    );
    expect(await landCharacter(run, undefined, null, true, gala.id)).toBe(
      'promoted'
    );
  });

  it('is revoked on every look by a bible edit the sheets read', async () => {
    const gala = await addLook();
    const galaRun = await claim(gala.id);
    const defaultRun = await claim();
    await chars().updateBible(
      sequenceId,
      characterId,
      { physicalDescription: 'short' },
      { source: 'edit', actorId: userId }
    );
    expect(await landCharacter(galaRun, undefined, null, true, gala.id)).toBe(
      'parked'
    );
    expect(await landCharacter(defaultRun)).toBe('parked');
  });

  it('edits the default look when the bible form changes the clothing', async () => {
    const run = await claim();
    await chars().updateBible(
      sequenceId,
      characterId,
      { standardClothing: 'black suit' },
      { source: 'edit', actorId: userId }
    );
    const row = await character();
    expect(row.standardClothing).toBe('black suit');
    expect(row.looks[0]?.clothing).toBe('black suit');
    expect(await landCharacter(run)).toBe('parked');
  });

  it('is not taken once the look moved after the snapshot (#1863)', async () => {
    const gala = await addLook();
    const snapshot = await snapshotOf(gala.id);
    await looks().update(
      sequenceId,
      gala.id,
      { clothing: 'blue gown' },
      { source: 'edit', actorId: userId }
    );
    const { versionId, held } = await looks().claimSheet(
      sequenceId,
      gala.id,
      snapshot,
      {
        markGenerating: true,
      }
    );
    expect(held).toBe(false);
    expect((await lookOf(gala.id)).pendingPromoteSheetVersionId).toBeNull();
    expect((await lookOf(gala.id)).sheetStatus).toBe('pending');
    // The run still lands somewhere: parked, never selected.
    expect(await landCharacter(versionId, undefined, null, true, gala.id)).toBe(
      'parked'
    );
    expect((await lookOf(gala.id)).selectedSheetVersionId).toBeNull();
  });

  it('is not taken once the bible or the cast moved after the snapshot', async () => {
    const snapshot = await snapshotOf(characterId);
    await chars().updateBible(
      sequenceId,
      characterId,
      { physicalDescription: 'short' },
      { source: 'edit', actorId: userId }
    );
    expect(
      (
        await looks().claimSheet(sequenceId, characterId, snapshot, {
          markGenerating: true,
        })
      ).held
    ).toBe(false);

    const recast = await snapshotOf(characterId);
    await castWith(null);
    expect(
      (
        await looks().claimSheet(sequenceId, characterId, recast, {
          markGenerating: true,
        })
      ).held
    ).toBe(false);
  });

  it('fails a claim by its own id, and only while that run holds it', async () => {
    const older = await claim();
    const newer = await claim();
    await looks().failSheetClaimByVersion(older, 'boom');
    expect((await character()).pendingPromoteSheetVersionId).toBe(newer);
    expect((await character()).sheetStatus).toBe('generating');
    await looks().failSheetClaimByVersion(newer, 'boom');
    const row = await character();
    expect(row.pendingPromoteSheetVersionId).toBeNull();
    expect(row.sheetStatus).toBe('failed');
  });

  it('clears only its own look on failure', async () => {
    const gala = await addLook();
    const galaRun = await claim(gala.id);
    const defaultRun = await claim();
    await looks().failSheetClaim(sequenceId, gala.id, galaRun, 'boom');
    expect((await lookOf(gala.id)).sheetStatus).toBe('failed');
    const row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(defaultRun);
    expect(row.sheetStatus).toBe('generating');
  });

  it('refuses to remove the default look, and restores a removed one', async () => {
    await expect(
      looks().remove(sequenceId, characterId, { actorId: userId })
    ).rejects.toThrow('default look');
    const gala = await addLook();
    await looks().remove(sequenceId, gala.id, { actorId: userId });
    expect((await lookOf(gala.id)).deletedAt).not.toBeNull();
    expect(await looks().listByCharacter(sequenceId, characterId)).toHaveLength(
      1
    );
    await looks().restore(sequenceId, gala.id, { actorId: userId });
    expect(await looks().listByCharacter(sequenceId, characterId)).toHaveLength(
      2
    );
  });

  it('re-selects an earlier look version, revoking the claim', async () => {
    const gala = await addLook();
    await looks().update(
      sequenceId,
      gala.id,
      { clothing: 'blue gown' },
      { source: 'edit', actorId: userId }
    );
    const run = await claim(gala.id);
    await looks().selectVersion(sequenceId, gala.id, gala.lookVersionId, {
      actorId: userId,
    });
    expect((await lookOf(gala.id)).clothing).toBe('red gown');
    expect(await landCharacter(run, undefined, null, true, gala.id)).toBe(
      'parked'
    );
  });

  it('writes analysed looks, matching a re-analysis by name so ids hold', async () => {
    const { lookIds: first } = await looks().syncFromAnalysis(
      sequenceId,
      characterId,
      [
        {
          lookId: 'c:default',
          name: 'Office',
          clothing: 'ignored',
          styling: '',
        },
        {
          lookId: 'c:gala',
          name: 'Gala gown',
          clothing: 'red gown',
          styling: '',
        },
      ]
    );
    // The default look keeps the character's id and takes the name; its
    // clothing came in with the character's upsert.
    expect(first['c:default']).toBe(characterId);
    const row = await character();
    expect(row.lookName).toBe('Office');
    expect(row.standardClothing).toBe('grey suit');
    const galaId = first['c:gala'];
    if (!galaId) throw new Error('gala not written');
    expect((await lookOf(galaId)).clothing).toBe('red gown');
    const run = await claim(galaId);

    // The script is re-analysed: same outfit under the same name (any case),
    // new wording, plus one more.
    const { lookIds: second } = await looks().syncFromAnalysis(
      sequenceId,
      characterId,
      [
        {
          lookId: 'c:default',
          name: 'Office',
          clothing: 'ignored',
          styling: '',
        },
        {
          lookId: 'c:gala_gown',
          name: 'gala GOWN',
          clothing: 'blue gown',
          styling: 'hair up',
        },
        {
          lookId: 'c:pyjamas',
          name: 'Pyjamas',
          clothing: 'striped',
          styling: '',
        },
      ]
    );
    expect(second['c:gala_gown']).toBe(galaId);
    expect(await lookOf(galaId)).toMatchObject({
      clothing: 'blue gown',
      styling: 'hair up',
    });
    // The moved clothing revoked the gown's sheet claim.
    expect(await landCharacter(run, undefined, null, true, galaId)).toBe(
      'parked'
    );
    expect(await looks().listByCharacter(sequenceId, characterId)).toHaveLength(
      3
    );

    // Only the name's case moves this time: one version, for the rename.
    const versions = (await looks().listVersions(galaId)).length;
    await looks().syncFromAnalysis(sequenceId, characterId, [
      { lookId: 'c:default', name: 'Office', clothing: 'ignored', styling: '' },
      {
        lookId: 'c:gala_gown',
        name: 'Gala gown',
        clothing: 'blue gown',
        styling: 'hair up',
      },
    ]);
    expect(await looks().listVersions(galaId)).toHaveLength(versions + 1);
  });

  it('retires a look the script dropped only when nothing is lost, and brings it back by name', async () => {
    const analysedLook = (name: string, clothing: string) => ({
      lookId: `c:${name}`,
      name,
      clothing,
      styling: '',
    });
    const office = analysedLook('Office', 'x');
    const { lookIds: first } = await looks().syncFromAnalysis(
      sequenceId,
      characterId,
      [
        office,
        analysedLook('Gala gown', 'red gown'),
        analysedLook('Pyjamas', 'striped'),
      ]
    );
    const galaId = first['c:Gala gown'] ?? '';
    const pyjamasId = first['c:Pyjamas'] ?? '';
    // A person's look, and an analysed look that has a sheet.
    const mine = await looks().create(
      sequenceId,
      characterId,
      { name: 'Raincoat', clothing: 'yellow', styling: null },
      { source: 'edit', actorId: userId }
    );
    await charVersions().applyConvergent({
      sequenceId,
      lookId: pyjamasId,
      url: '/r2/pyjamas.png',
      storagePath: '/pyjamas.png',
      inputHash: HASH,
      model: 'm',
    });

    // The script is re-analysed and names only the default outfit.
    await looks().syncFromAnalysis(sequenceId, characterId, [office]);
    expect((await lookOf(galaId)).deletedAt).not.toBeNull();
    expect((await lookOf(pyjamasId)).deletedAt).toBeNull();
    expect((await lookOf(mine.id)).deletedAt).toBeNull();

    // Named again: the same row comes back, not a twin.
    const { lookIds: again } = await looks().syncFromAnalysis(
      sequenceId,
      characterId,
      [office, analysedLook('gala gown', 'red gown')]
    );
    expect(again['c:gala gown']).toBe(galaId);
    expect((await lookOf(galaId)).deletedAt).toBeNull();
  });

  it('refuses a second look with a name the character already has', async () => {
    const gala = await addLook();
    await expect(addLook()).rejects.toThrow('already has a look named');
    const other = await looks().create(
      sequenceId,
      characterId,
      { name: 'Pyjamas', clothing: null, styling: null },
      { source: 'edit', actorId: userId }
    );
    await expect(
      looks().update(
        sequenceId,
        other.id,
        { name: 'gala GOWN' },
        { source: 'edit', actorId: userId }
      )
    ).rejects.toThrow('already has a look named');
    // Renaming a look to its own name in another case is fine.
    await looks().update(
      sequenceId,
      gala.id,
      { name: 'Gala Gown' },
      { source: 'edit', actorId: userId }
    );
  });

  it('refuses to remove a look a scene still wears, naming the scene', async () => {
    const gala = await addLook();
    const [scene] = await db
      .insert(scenes)
      .values({ sequenceId, orderIndex: 1 })
      .returning();
    if (!scene) throw new Error('setup');
    await db.insert(sceneScriptVersions).values({
      id: 'ssv-1',
      sceneId: scene.id,
      content: { extract: 'x', dialogue: [] },
      continuity: {
        characterTags: ['sam'],
        characterLooks: { sam: gala.id },
        environmentTag: '',
        lightingSetup: '',
        styleTag: '',
      },
      source: 'split',
    });
    await db
      .update(scenes)
      .set({ selectedScriptVersionId: 'ssv-1' })
      .where(eq(scenes.id, scene.id));
    await expect(
      looks().remove(sequenceId, gala.id, { actorId: userId })
    ).rejects.toThrow(
      'Gala gown is worn in scene 2. Pick another look there first.'
    );
    expect((await lookOf(gala.id)).deletedAt).toBeNull();
  });

  it('refuses to remove a look another sequence wears, naming it; an archived one does not refuse', async () => {
    const gala = await addLook();
    // A second sequence casts the character and uses the look (#2050's
    // attach), and one of its scenes wears it.
    const [first] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!first) throw new Error('setup');
    const other = generateId();
    await db.insert(sequences).values({
      id: other,
      teamId,
      title: 'Episode 2',
      styleId: first.styleId,
    });
    const character = await chars().getById(sequenceId, characterId);
    if (!character) throw new Error('setup');
    const [link] = await db
      .insert(sequenceCast)
      .values({
        sequenceId: other,
        characterId,
        scriptCharacterId: 'char_001',
        bibleVersionId: character.selectedBibleVersionId,
      })
      .returning();
    if (!link) throw new Error('setup');
    await db.insert(sequenceCastLooks).values({
      castId: link.id,
      lookId: gala.id,
      lookVersionId: gala.lookVersionId,
      sheetStatus: 'pending',
    });
    const [scene] = await db
      .insert(scenes)
      .values({ sequenceId: other, orderIndex: 0 })
      .returning();
    if (!scene) throw new Error('setup');
    await db.insert(sceneScriptVersions).values({
      id: 'ssv-other',
      sceneId: scene.id,
      content: { extract: 'x', dialogue: [] },
      continuity: {
        characterTags: ['sam'],
        characterLooks: { sam: gala.id },
        environmentTag: '',
        lightingSetup: '',
        styleTag: '',
      },
      source: 'split',
    });
    await db
      .update(scenes)
      .set({ selectedScriptVersionId: 'ssv-other' })
      .where(eq(scenes.id, scene.id));

    await expect(
      looks().remove(sequenceId, gala.id, { actorId: userId })
    ).rejects.toThrow(
      'Gala gown is worn in Episode 2. Pick another look there first.'
    );
    expect((await lookOf(gala.id)).deletedAt).toBeNull();

    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, other));
    await looks().remove(sequenceId, gala.id, { actorId: userId });
    expect((await lookOf(gala.id)).deletedAt).not.toBeNull();
  });

  it('fills in the default look of a character an older worker wrote', async () => {
    // What a pre-#2015 worker leaves: no look, state on the legacy columns.
    await db.delete(sequenceCastLooks);
    await db.delete(characterLookVersions);
    await db.delete(characterLooks);
    await db
      .update(characters)
      .set({ legacySheetStatus: 'failed', legacyStandardClothing: 'old coat' })
      .where(eq(characters.id, characterId));
    await db
      .update(characterBibleVersions)
      .set({ legacyStandardClothing: 'old coat' })
      .where(eq(characterBibleVersions.characterId, characterId));

    const before = await character();
    expect(before.looks).toEqual([]);
    expect(before.lookId).toBe(characterId);
    expect(before.standardClothing).toBe('old coat');
    expect(before.sheetStatus).toBe('failed');

    const look = await looks().ensureDefault(sequenceId, characterId);
    expect(look).toMatchObject({
      id: characterId,
      isDefault: true,
      clothing: 'old coat',
      sheetStatus: 'failed',
    });
    expect((await character()).looks).toHaveLength(1);
  });
});

describe('sequence location claims', () => {
  const landLocation = (versionId: string) =>
    locVersions().promoteIfPending({
      locationId,
      versionId,
      claimed: true,
      url: `/r2/${versionId}.png`,
      storagePath: `${versionId}.png`,
      inputHash: LOC_HASH,
      bibleVersionId: null,
      model: 'm',
      workflowRunId: 'run',
    });

  it('lands while held and parks after a bible edit', async () => {
    const first = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    expect(await landLocation(first)).toBe('promoted');

    const second = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    await locs().updateBible(
      locationId,
      { keyFeatures: 'neon sign' },
      { actorId: userId }
    );
    expect(await landLocation(second)).toBe('parked');
  });

  it('is revoked by a relink and by the library reference moving', async () => {
    let versionId = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    await locs().update(locationId, { libraryLocationId: libraryId });
    expect(await landLocation(versionId)).toBe('parked');

    versionId = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    const claimId = await library().claimReference(libraryId);
    await library().updateReferenceIfClaimed(
      libraryId,
      claimId,
      '/r2/preview.png',
      'preview.png',
      libraryLocationReferenceInputHash('c'.repeat(64))
    );
    expect(await landLocation(versionId)).toBe('parked');
  });

  // The bible parent's claim (#1863): taken only while the snapshot is live.
  const snapshot = async () => {
    const row = await locs().getById(locationId);
    if (!row?.selectedBibleVersionId) throw new Error('no bible version');
    return {
      bibleVersionId: row.selectedBibleVersionId,
      libraryLocationId: row.libraryLocationId,
    };
  };

  it('a conditional claim is held while the bible and link are live', async () => {
    const claim = await locs().claimReferenceIfUnmoved(
      locationId,
      await snapshot()
    );
    expect(claim.held).toBe(true);
    expect(await landLocation(claim.versionId)).toBe('promoted');
  });

  it('a conditional claim is not taken after a bible edit, and the run parks', async () => {
    const before = await snapshot();
    await locs().updateBible(
      locationId,
      { keyFeatures: 'neon sign' },
      { actorId: userId }
    );
    const claim = await locs().claimReferenceIfUnmoved(locationId, before);
    expect(claim.held).toBe(false);
    expect(await landLocation(claim.versionId)).toBe('parked');
  });

  it('a conditional claim is not taken after a relink', async () => {
    const before = await snapshot();
    await locs().update(locationId, { libraryLocationId: null });
    const claim = await locs().claimReferenceIfUnmoved(locationId, before);
    expect(claim.held).toBe(false);
  });
});

describe('library location claims', () => {
  const HASH_L = libraryLocationReferenceInputHash('d'.repeat(64));

  it('publishes while held, idempotently', async () => {
    const claimId = await library().claimReference(libraryId);
    const publish = () =>
      library().updateReferenceIfClaimed(
        libraryId,
        claimId,
        '/r2/p1.png',
        'p1.png',
        HASH_L
      );
    expect(await publish()).toBe(true);
    expect(await publish()).toBe(true);
    const row = await library().getById(libraryId);
    expect(row?.referenceImageUrl).toBe('/r2/p1.png');
    expect(row?.pendingReferenceClaimId).toBeNull();
  });

  it('does not publish after a description edit, but survives a rename', async () => {
    const kept = await library().claimReference(libraryId);
    await library().update(libraryId, { name: 'Cafe' });
    expect((await library().getById(libraryId))?.pendingReferenceClaimId).toBe(
      kept
    );

    const claimId = await library().claimReference(libraryId);
    await library().update(libraryId, { description: 'greasy' });
    expect(
      await library().updateReferenceIfClaimed(
        libraryId,
        claimId,
        '/r2/p2.png',
        'p2.png',
        HASH_L
      )
    ).toBe(false);
    expect((await library().getById(libraryId))?.referenceImageUrl).toBeNull();
  });

  it('does not overwrite a reference the user set mid-run', async () => {
    const claimId = await library().claimReference(libraryId);
    await library().update(libraryId, {
      referenceImageUrl: '/r2/mine.png',
      referenceImagePath: 'mine.png',
    });
    expect(
      await library().updateReferenceIfClaimed(
        libraryId,
        claimId,
        '/r2/p3.png',
        'p3.png',
        HASH_L
      )
    ).toBe(false);
    expect((await library().getById(libraryId))?.referenceImageUrl).toBe(
      '/r2/mine.png'
    );
  });

  it('keeps a newer claim when an older run fails', async () => {
    const older = await library().claimReference(libraryId);
    const newer = await library().claimReference(libraryId);
    await library().clearReferenceClaimIf(libraryId, older);
    expect((await library().getById(libraryId))?.pendingReferenceClaimId).toBe(
      newer
    );
  });
});

describe('library talent claims', () => {
  const NO_INPUTS = { description: null, referenceImageUrls: [] };
  const LAST_WINS = { onlyIfFree: false };
  const claimTalent = async () => {
    const sheetId = generateId();
    await talents().claimSheet(talentId, sheetId, NO_INPUTS, LAST_WINS);
    return sheetId;
  };
  const T_HASH = talentSheetInputHash('e'.repeat(64));
  const land = (sheetId: string, source: 'ai_generated' | 'manual_upload') =>
    talents().landSheet({
      sheetId,
      talentId,
      imageUrl: `/r2/${sheetId}.png`,
      imagePath: `${sheetId}.png`,
      metadata: undefined,
      source,
      inputHash: T_HASH,
    });
  const talentRow = async () => {
    const row = await db.query.talent.findFirst({ where: { id: talentId } });
    if (!row) throw new Error('talent gone');
    return row;
  };

  it('lands a held claim as the reference sheet and revokes cast sheets', async () => {
    const castClaim = await claim();
    const sheetId = await claimTalent();

    const { sheet, landed } = await land(sheetId, 'manual_upload');
    expect(landed).toBe(true);
    expect(sheet.divergedAt).toBeNull();
    const row = await talentRow();
    expect(row.selectedSheetId).toBe(sheetId);
    expect(row.pendingPromoteSheetId).toBeNull();
    expect((await character()).pendingPromoteSheetVersionId).toBeNull();
    expect(await landCharacter(castClaim)).toBe('parked');

    // Retry of the same step: same row, still landed.
    expect((await land(sheetId, 'manual_upload')).landed).toBe(true);
  });

  it('a new sheet replaces the reference sheet while its claim holds (#2018)', async () => {
    const first = await claimTalent();
    await land(first, 'ai_generated');
    const second = await claimTalent();
    await land(second, 'ai_generated');
    expect((await talentRow()).selectedSheetId).toBe(second);
  });

  it('parks after a description edit and leaves the pointer alone', async () => {
    const sheetId = await claimTalent();
    await talents().update(talentId, { description: 'new' });
    const { sheet, landed } = await land(sheetId, 'manual_upload');
    expect(landed).toBe(false);
    expect(sheet.divergedAt).not.toBeNull();
    expect((await talentRow()).selectedSheetId).not.toBe(sheetId);
  });

  it('refuses the claim when an input moved after the snapshot', async () => {
    const media = await talents().media.create({
      talentId,
      type: 'image',
      url: '/r2/photo.png',
      path: 'photo.png',
    });
    const inputs = { description: null, referenceImageUrls: [media.url] };
    expect(
      await talents().claimSheet(talentId, generateId(), inputs, LAST_WINS)
    ).toBe(true);

    await talents().update(talentId, { description: 'edited' });
    expect(
      await talents().claimSheet(talentId, generateId(), inputs, LAST_WINS)
    ).toBe(false);

    const edited = { ...inputs, description: 'edited' };
    await talents().media.delete(media.id);
    expect(
      await talents().claimSheet(talentId, generateId(), edited, LAST_WINS)
    ).toBe(false);
  });

  it('onlyIfFree refuses while a run holds the claim; a new photo revokes it', async () => {
    const held = await claimTalent();
    expect(
      await talents().claimSheet(talentId, generateId(), NO_INPUTS, {
        onlyIfFree: true,
      })
    ).toBe(false);
    expect((await talentRow()).pendingPromoteSheetId).toBe(held);

    await talents().media.create({
      talentId,
      type: 'image',
      url: '/r2/new-photo.png',
      path: 'new-photo.png',
    });
    expect((await talentRow()).pendingPromoteSheetId).toBeNull();
    expect((await land(held, 'ai_generated')).landed).toBe(false);
  });

  it('parks an older run once a newer run claims', async () => {
    const older = await claimTalent();
    const newer = await claimTalent();
    expect((await land(older, 'ai_generated')).landed).toBe(false);
    expect((await land(newer, 'ai_generated')).landed).toBe(true);
  });

  it('the user pick wins: selectSheet unparks, moves the pointer and revokes claims', async () => {
    const current = await claimTalent();
    await land(current, 'ai_generated');
    const parkedId = await claimTalent();
    await talents().update(talentId, { description: 'moved' });
    expect((await land(parkedId, 'ai_generated')).landed).toBe(false);

    const inFlight = await claimTalent();
    const castClaim = await claim();
    const picked = await talents().selectSheet(talentId, parkedId);
    expect(picked.divergedAt).toBeNull();
    const row = await talentRow();
    expect(row.selectedSheetId).toBe(parkedId);
    expect(row.pendingPromoteSheetId).toBeNull();
    expect((await land(inFlight, 'ai_generated')).landed).toBe(false);
    expect(await landCharacter(castClaim)).toBe('parked');
  });

  it('the reference sheet cannot be discarded; a discarded sheet cannot be selected until restored', async () => {
    const current = await claimTalent();
    await land(current, 'ai_generated');
    await expect(talents().sheets.discard(current)).rejects.toThrow(
      /reference sheet/
    );

    const older = await claimTalent();
    await land(older, 'ai_generated');
    // `older` is now the reference; `current` is history.
    await talents().sheets.discard(current);
    await expect(talents().selectSheet(talentId, current)).rejects.toThrow(
      /Restore/
    );
    await talents().sheets.undiscard(current);
    expect((await talents().selectSheet(talentId, current)).id).toBe(current);
  });

  it('refuses to delete a talent while a character version casts it (#2018)', async () => {
    await castWith(talentId);
    await expect(talents().delete(talentId)).rejects.toThrow(
      /character version/
    );
  });
});

describe('re-analysis upserts (#1113)', () => {
  const upsertCharacter = async (change: Partial<NewCharacter>) =>
    chars().create(
      { ...(await character()), id: generateId(), ...change },
      { source: 'analysis', createdBy: null }
    );
  const location = async () => {
    const row = await locs().getById(locationId);
    if (!row) throw new Error('location gone');
    return row;
  };

  it('revokes a character claim when a sheet input moved', async () => {
    const versionId = await claim();
    await upsertCharacter({ physicalDescription: 'short' });
    expect(await landCharacter(versionId)).toBe('parked');
  });

  it('keeps a character claim when the rewrite is identical', async () => {
    const versionId = await claim();
    await upsertCharacter({});
    expect(await landCharacter(versionId)).toBe('promoted');
  });

  it('revokes a location claim when the bulk upsert moves an input', async () => {
    await locs().claimReference(locationId, { markGenerating: true });
    await locs().createBulk(
      [{ ...(await location()), id: generateId(), description: 'moved' }],
      { source: 'analysis', createdBy: null }
    );
    expect((await location()).pendingPromoteReferenceVersionId).toBeNull();
  });

  it('keeps a location claim when the bulk upsert is identical', async () => {
    const claim = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    await locs().createBulk([{ ...(await location()), id: generateId() }], {
      source: 'analysis',
      createdBy: null,
    });
    expect((await location()).pendingPromoteReferenceVersionId).toBe(claim);
  });

  it('a pointer-only claim leaves the status alone', async () => {
    await db
      .update(sequenceCastLooks)
      .set({ sheetStatus: 'completed' })
      .where(eq(sequenceCastLooks.lookId, characterId));
    await looks().claimSheet(
      sequenceId,
      characterId,
      await snapshotOf(characterId),
      {
        markGenerating: false,
      }
    );
    expect((await character()).sheetStatus).toBe('completed');
  });
});
