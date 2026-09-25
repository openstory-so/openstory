/**
 * Sheet claims (#1113) against real SQLite: the trigger claims, every input
 * edit or user pick demotes, completion promotes only while the claim holds
 * and otherwise parks, and a failure clears only its own claim.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import {
  characterSheetVariants,
  characters,
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
import type { Database } from '@/platform/server/db/client';
import {
  characterSheetInputHash,
  libraryLocationReferenceInputHash,
  locationSheetInputHash,
  talentSheetInputHash,
} from '@/shots/input-hash';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
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
  const [ch] = await db
    .insert(characters)
    .values({
      sequenceId,
      characterId: 'char_001',
      name: 'Sam',
      physicalDescription: 'tall',
      talentId,
    })
    .returning();
  const [loc] = await db
    .insert(sequenceLocations)
    .values({
      sequenceId,
      locationId: 'loc_001',
      name: 'Diner',
      libraryLocationId: libraryId,
    })
    .returning();
  if (!ch || !loc) throw new Error('setup');
  characterId = ch.id;
  locationId = loc.id;
});

const chars = () => createCharactersMethods(db);
const charVersions = () => createCharacterSheetVariantsMethods(db);
const locs = () => createSequenceLocationsMethods(db);
const locVersions = () => createLocationSheetVariantsMethods(db);
const library = () => createLocationsMethods(db, teamId, userId);
const talents = () => createTalentMethods(db, teamId, userId);

async function character() {
  const [row] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!row) throw new Error('character gone');
  return row;
}

async function version(id: string) {
  const [row] = await db
    .select()
    .from(characterSheetVariants)
    .where(eq(characterSheetVariants.id, id));
  return row;
}

const landCharacter = (versionId: string, url = `/r2/${versionId}.png`) =>
  charVersions().promoteIfPending({
    characterId,
    versionId,
    url,
    storagePath: url,
    inputHash: HASH,
    model: 'm',
    workflowRunId: `run-${versionId}`,
  });

describe('character sheet claims', () => {
  it('lands a run that still holds its claim', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    expect((await character()).sheetStatus).toBe('generating');

    expect(await landCharacter(versionId)).toBe('promoted');
    const row = await character();
    expect(row.selectedSheetVersionId).toBe(versionId);
    expect(row.pendingPromoteSheetVersionId).toBeNull();
    expect(row.sheetStatus).toBe('completed');
    expect((await version(versionId))?.divergedAt).toBeNull();
  });

  it('parks a run whose bible was edited mid-flight, leaving the live sheet', async () => {
    const first = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await landCharacter(first);

    const second = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await chars().updateBible(
      characterId,
      { physicalDescription: 'short' },
      { actorId: userId }
    );

    expect(await landCharacter(second)).toBe('parked');
    const row = await character();
    expect(row.selectedSheetVersionId).toBe(first);
    expect(row.sheetStatus).toBe('completed');
    expect((await version(second))?.divergedAt).not.toBeNull();
  });

  it('keeps the claim when the edit touches no field the sheet reads', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await chars().updateBible(
      characterId,
      { personality: 'wry', physicalDescription: 'tall' },
      { actorId: userId }
    );
    expect(await landCharacter(versionId)).toBe('promoted');
  });

  it('lets a newer kickoff win over a late completion', async () => {
    const older = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    const newer = await chars().claimSheet(characterId, {
      markGenerating: true,
    });

    expect(await landCharacter(older)).toBe('parked');
    let row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');

    expect(await landCharacter(newer)).toBe('promoted');
    row = await character();
    expect(row.selectedSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('completed');
  });

  it('clears only its own claim when it fails', async () => {
    const older = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    const newer = await chars().claimSheet(characterId, {
      markGenerating: true,
    });

    await chars().failSheetClaim(characterId, older, 'boom');
    let row = await character();
    expect(row.pendingPromoteSheetVersionId).toBe(newer);
    expect(row.sheetStatus).toBe('generating');

    await chars().failSheetClaim(characterId, newer, 'boom');
    row = await character();
    expect(row.pendingPromoteSheetVersionId).toBeNull();
    expect(row.sheetStatus).toBe('failed');
  });

  it('is retry-safe: landing twice promotes once', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    expect(await landCharacter(versionId)).toBe('promoted');
    expect(await landCharacter(versionId)).toBe('promoted');
    const rows = await db
      .select()
      .from(characterSheetVariants)
      .where(eq(characterSheetVariants.characterId, characterId));
    expect(rows).toHaveLength(1);
  });

  it("parks behind the user's pick of another sheet", async () => {
    const first = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await landCharacter(first);
    const second = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await charVersions().select(characterId, first, { actorId: userId });
    expect(await landCharacter(second)).toBe('parked');
  });

  it('does not collide with an identical parked twin', async () => {
    const a = await chars().claimSheet(characterId, { markGenerating: true });
    const b = await chars().claimSheet(characterId, { markGenerating: true });
    const c = await chars().claimSheet(characterId, { markGenerating: true });
    expect(await landCharacter(a)).toBe('parked');
    // Same (character, model, hash) as `a`: stays plain history, no throw.
    expect(await landCharacter(b)).toBe('parked');
    expect((await version(b))?.divergedAt).toBeNull();
    expect(await landCharacter(c)).toBe('promoted');
  });

  it('is revoked by a recast and by a change to the cast talent', async () => {
    let versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await chars().updateTalent(characterId, talentId);
    expect(await landCharacter(versionId)).toBe('parked');

    versionId = await chars().claimSheet(characterId, { markGenerating: true });
    await talents().sheets.create({
      talentId,
      name: 'New look',
      imageUrl: '/r2/look.png',
    });
    expect(await landCharacter(versionId)).toBe('parked');

    versionId = await chars().claimSheet(characterId, { markGenerating: true });
    await talents().update(talentId, { description: 'older now' });
    expect(await landCharacter(versionId)).toBe('parked');
  });

  it('is revoked by a style change on the sequence', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await db.batch(demoteSequenceSheetClaims(db, sequenceId));
    expect(await landCharacter(versionId)).toBe('parked');
  });
});

describe('sequence location claims', () => {
  const landLocation = (versionId: string) =>
    locVersions().promoteIfPending({
      locationId,
      versionId,
      url: `/r2/${versionId}.png`,
      storagePath: `${versionId}.png`,
      inputHash: LOC_HASH,
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
      { lightingSetup: 'neon' },
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
  const claimTalent = async () => {
    const sheetId = generateId();
    await talents().claimSheet(talentId, sheetId);
    return sheetId;
  };
  const T_HASH = talentSheetInputHash('e'.repeat(64));
  const land = (sheetId: string, source: 'ai_generated' | 'manual_upload') =>
    talents().landSheet({
      sheetId,
      talentId,
      name: 'Sheet',
      imageUrl: `/r2/${sheetId}.png`,
      imagePath: `${sheetId}.png`,
      metadata: undefined,
      source,
      inputHash: T_HASH,
    });

  it('lands a held claim, makes a first upload the default, and revokes cast sheets', async () => {
    const castClaim = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    const sheetId = await claimTalent();

    const { sheet, landed } = await land(sheetId, 'manual_upload');
    expect(landed).toBe(true);
    expect(sheet.divergedAt).toBeNull();
    expect(sheet.isDefault).toBe(true);
    expect((await character()).pendingPromoteSheetVersionId).toBeNull();
    expect(await landCharacter(castClaim)).toBe('parked');

    // Retry of the same step: same row, still landed.
    expect((await land(sheetId, 'manual_upload')).landed).toBe(true);
  });

  it('parks after a description edit, never as default', async () => {
    const sheetId = await claimTalent();
    await talents().update(talentId, { description: 'new' });
    const { sheet, landed } = await land(sheetId, 'manual_upload');
    expect(landed).toBe(false);
    expect(sheet.divergedAt).not.toBeNull();
    expect(sheet.isDefault).toBe(false);
  });

  it('parks an older run once a newer run claims', async () => {
    const older = await claimTalent();
    const newer = await claimTalent();
    expect((await land(older, 'ai_generated')).landed).toBe(false);
    expect((await land(newer, 'ai_generated')).landed).toBe(true);
  });
});

describe('re-analysis upserts (#1113)', () => {
  const upsertCharacter = async (
    change: Partial<typeof characters.$inferInsert>
  ) => chars().create({ ...(await character()), id: generateId(), ...change });
  const location = async () => {
    const [row] = await db
      .select()
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, locationId));
    if (!row) throw new Error('location gone');
    return row;
  };

  it('revokes a character claim when a sheet input moved', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await upsertCharacter({ physicalDescription: 'short' });
    expect(await landCharacter(versionId)).toBe('parked');
  });

  it('keeps a character claim when the rewrite is identical', async () => {
    const versionId = await chars().claimSheet(characterId, {
      markGenerating: true,
    });
    await upsertCharacter({});
    expect(await landCharacter(versionId)).toBe('promoted');
  });

  it('revokes a location claim when the bulk upsert moves an input', async () => {
    await locs().claimReference(locationId, { markGenerating: true });
    await locs().createBulk([
      { ...(await location()), id: generateId(), description: 'moved' },
    ]);
    expect((await location()).pendingPromoteReferenceVersionId).toBeNull();
  });

  it('keeps a location claim when the bulk upsert is identical', async () => {
    const claim = await locs().claimReference(locationId, {
      markGenerating: true,
    });
    await locs().createBulk([{ ...(await location()), id: generateId() }]);
    expect((await location()).pendingPromoteReferenceVersionId).toBe(claim);
  });

  it('a pointer-only claim leaves the status alone', async () => {
    await db
      .update(characters)
      .set({ sheetStatus: 'completed' })
      .where(eq(characters.id, characterId));
    await chars().claimSheet(characterId, { markGenerating: false });
    expect((await character()).sheetStatus).toBe('completed');
  });
});
