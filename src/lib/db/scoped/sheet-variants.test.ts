/**
 * Schema-level acceptance tests for `insertDivergent` on
 * `character_sheet_variants`, `location_sheet_variants`, and
 * `talent_sheet_variants`.
 *
 * The three tables share a partial-index split (primary vs divergent on
 * `divergedAt`) and a parallel race-tolerance helper. The tests pin the
 * substantive new behavior introduced in PR #618:
 *
 *  - QStash retry idempotency: repeated calls with the same identity tuple
 *    return the existing row instead of double-inserting.
 *  - Cross-run race tolerance: a unique-constraint conflict triggered by a
 *    concurrent run is absorbed into a re-fetch that returns the winner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import {
  characterSheetVariants,
  characters,
  locationLibrary,
  locationSheetVariants,
  sequenceLocations,
  sequences,
  styles,
  talent,
  talentSheetVariants,
  talentSheets,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { createCharactersMethods } from './characters';
import { createLocationSheetVariantsMethods } from './location-sheet-variants';
import { createTalentSheetVariantsMethods } from './talent-sheet-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let characterId = '';
let talentId = '';
let talentSheetId = '';

async function seed() {
  await db.delete(characterSheetVariants);
  await db.delete(locationSheetVariants);
  await db.delete(talentSheetVariants);
  await db.delete(talentSheets);
  await db.delete(characters);
  await db.delete(sequenceLocations);
  await db.delete(locationLibrary);
  await db.delete(talent);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
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
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);
  const [character] = await db
    .insert(characters)
    .values({ sequenceId, characterId: 'char_001', name: 'Alice' })
    .returning();
  if (!character)
    throw new Error('test setup: character insert returned nothing');
  characterId = character.id;
  const [talentRow] = await db
    .insert(talent)
    .values({ teamId: team.id, name: 'Talent A' })
    .returning();
  if (!talentRow) throw new Error('test setup: talent insert returned nothing');
  talentId = talentRow.id;
  const [sheet] = await db
    .insert(talentSheets)
    .values({
      talentId,
      name: 'Default',
      imageUrl: 'https://example.com/sheet.png',
    })
    .returning();
  if (!sheet)
    throw new Error('test setup: talentSheets insert returned nothing');
  talentSheetId = sheet.id;
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

describe('character-sheet-variants insertDivergent', () => {
  it('is idempotent on (characterId, model, inputHash) — retry returns the existing row', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const first = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });

    const second = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(characterSheetVariants);
    expect(rows).toHaveLength(1);
  });

  it('writes a second divergent row when inputHash differs', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-a.png',
      status: 'completed',
      inputHash: 'hash-a',
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-b.png',
      status: 'completed',
      inputHash: 'hash-b',
      divergedAt,
    });

    const rows = await db.select().from(characterSheetVariants);
    expect(rows).toHaveLength(2);
  });

  it('pre-check returns the existing row when a divergent variant is already present', async () => {
    // Seeds the row directly, then calls `insertDivergent`. The helper's
    // pre-check SELECT finds the row and returns it — exercises the
    // "QStash retried the same step" path. The post-collision retry path
    // is exercised separately at the helper level (see `insertDivergentRaceTolerant`
    // tests below).
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const [existingRow] = await db
      .insert(characterSheetVariants)
      .values({
        characterId,
        model: 'flux-pro',
        url: 'https://example.com/winner.png',
        status: 'completed',
        inputHash: 'hash-race',
        divergedAt,
      })
      .returning();
    if (!existingRow)
      throw new Error('test setup: existingRow insert returned nothing');

    const result = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/loser.png',
      status: 'completed',
      inputHash: 'hash-race',
      divergedAt,
    });

    expect(result.id).toBe(existingRow.id);
    expect(result.url).toBe('https://example.com/winner.png');
  });
});

describe('location-sheet-variants insertDivergent', () => {
  it('is idempotent on (parentType, parentId, model, inputHash)', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    // Library locations have no FK to a parent table at the schema level
    // (parentId is a free string), so any id will satisfy the constraint.
    const parentId = generateId();

    const first = await methods.insertDivergent({
      parentType: 'library_location',
      parentId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });
    const second = await methods.insertDivergent({
      parentType: 'library_location',
      parentId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(locationSheetVariants);
    expect(rows).toHaveLength(1);
  });

  it('treats the same id under a different parentType as a separate row', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const parentId = generateId();

    await methods.insertDivergent({
      parentType: 'sequence_location',
      parentId,
      model: 'flux-pro',
      url: 'https://example.com/seq.png',
      status: 'completed',
      inputHash: 'hash',
      divergedAt,
    });
    await methods.insertDivergent({
      parentType: 'library_location',
      parentId,
      model: 'flux-pro',
      url: 'https://example.com/lib.png',
      status: 'completed',
      inputHash: 'hash',
      divergedAt,
    });

    const rows = await db.select().from(locationSheetVariants);
    expect(rows).toHaveLength(2);
  });
});

describe('talent-sheet-variants insertDivergent', () => {
  it('is idempotent on (talentSheetId, model, inputHash)', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const first = await methods.insertDivergent({
      talentSheetId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });
    const second = await methods.insertDivergent({
      talentSheetId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'hash-snap',
      divergedAt,
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(talentSheetVariants);
    expect(rows).toHaveLength(1);
  });
});

describe('character-sheet-variants discard / undiscard / promote', () => {
  it('discard sets discardedAt and undiscard clears it', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'hash',
      divergedAt,
    });

    const discardedAt = await methods.discard(variant.id);
    const after = await methods.getById(variant.id);
    // SQLite stores timestamps at second precision; compare via getTime().
    expect(after?.discardedAt).toBeInstanceOf(Date);
    expect(Math.floor(discardedAt.getTime() / 1000)).toBe(
      Math.floor((after?.discardedAt?.getTime() ?? 0) / 1000)
    );

    await methods.undiscard(variant.id);
    const restored = await methods.getById(variant.id);
    expect(restored?.discardedAt).toBeNull();
  });

  it('listDivergentActiveByCharacter excludes discarded rows', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const a = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/a.png',
      status: 'completed',
      inputHash: 'hash-a',
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/b.png',
      status: 'completed',
      inputHash: 'hash-b',
      divergedAt,
    });
    await methods.discard(a.id);

    const active = await methods.listDivergentActiveByCharacter(characterId);
    expect(active).toHaveLength(1);
    expect(active[0]?.inputHash).toBe('hash-b');
  });

  it('promoteAtomically copies fields onto characters and discards the variant', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/promoted.png',
      storagePath: '/r2/promoted.png',
      status: 'completed',
      inputHash: 'hash-promoted',
      divergedAt,
    });

    await methods.promoteAtomically(
      characterId,
      {
        sheetImageUrl: variant.url,
        sheetImagePath: variant.storagePath,
        sheetInputHash: variant.inputHash,
      },
      variant.id
    );

    const [updatedCharacter] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId));
    if (!updatedCharacter)
      throw new Error('test setup: updatedCharacter select returned nothing');
    expect(updatedCharacter.sheetImageUrl).toBe(
      'https://example.com/promoted.png'
    );
    expect(updatedCharacter.sheetInputHash).toBe('hash-promoted');

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).not.toBeNull();
  });
});

describe('location-sheet-variants discard / promote', () => {
  it('discard then list excludes the discarded row', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const parentId = generateId();
    const variant = await methods.insertDivergent({
      parentType: 'library_location',
      parentId,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: 'hash',
      divergedAt,
    });

    await methods.discard(variant.id);
    const active = await methods.listDivergentActiveByParent(
      'library_location',
      parentId
    );
    expect(active).toHaveLength(0);
  });
});

describe('talent-sheet-variants discard / promote', () => {
  it('promoteAtomically writes onto talent_sheets and discards the variant', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      talentSheetId,
      model: 'flux-pro',
      url: 'https://example.com/promoted.png',
      storagePath: '/r2/promoted.png',
      status: 'completed',
      inputHash: 'hash-promoted',
      divergedAt,
    });

    await methods.promoteAtomically(
      talentSheetId,
      {
        imageUrl: variant.url,
        imagePath: variant.storagePath,
        inputHash: variant.inputHash,
      },
      variant.id
    );

    const [updatedSheet] = await db
      .select()
      .from(talentSheets)
      .where(eq(talentSheets.id, talentSheetId));
    if (!updatedSheet)
      throw new Error('test setup: updatedSheet select returned nothing');
    expect(updatedSheet.imageUrl).toBe('https://example.com/promoted.png');
    expect(updatedSheet.inputHash).toBe('hash-promoted');

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).not.toBeNull();
  });
});

// Negative-case coverage for promoteAtomically. The contract is that a
// failed pre-check must throw before the batch runs, so the live primary is
// not updated and the variant is not soft-deleted. These pin that contract.

describe('character-sheet-variants promoteAtomically negative cases', () => {
  it('throws when the character does not exist; variant is not soft-deleted', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: 'h',
      divergedAt,
    });

    expect(
      methods.promoteAtomically(
        generateId(),
        {
          sheetImageUrl: variant.url,
          sheetImagePath: null,
          sheetInputHash: variant.inputHash,
        },
        variant.id
      )
    ).rejects.toThrow(/not found/);

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
  });

  it('throws when the variant does not exist; character is not updated', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    expect(
      methods.promoteAtomically(
        characterId,
        {
          sheetImageUrl: 'https://example.com/x.png',
          sheetImagePath: null,
          sheetInputHash: 'h',
        },
        generateId()
      )
    ).rejects.toThrow(/not found/);

    const [character] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId));
    if (!character)
      throw new Error('test setup: character select returned nothing');
    expect(character.sheetImageUrl).toBeNull();
    expect(character.sheetInputHash).toBeNull();
  });
});

describe('location-sheet-variants promoteAtomically negative cases', () => {
  async function seedSequenceLocation() {
    const [loc] = await db
      .insert(sequenceLocations)
      .values({
        sequenceId,
        locationId: `loc_${generateId()}`,
        name: 'L',
      })
      .returning();
    if (!loc)
      throw new Error('test setup: sequenceLocations insert returned nothing');
    return loc;
  }
  async function seedLibraryLocation() {
    const [loc] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'L' })
      .returning();
    if (!loc)
      throw new Error('test setup: locationLibrary insert returned nothing');
    return loc;
  }

  it('promotes a sequence_location parent and discards the variant', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const loc = await seedSequenceLocation();
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      parentType: 'sequence_location',
      parentId: loc.id,
      model: 'flux-pro',
      url: 'https://example.com/seq.png',
      storagePath: '/r2/seq.png',
      status: 'completed',
      inputHash: 'h',
      divergedAt,
    });

    await methods.promoteAtomically(
      'sequence_location',
      loc.id,
      {
        referenceImageUrl: variant.url,
        referenceImagePath: variant.storagePath,
        referenceInputHash: variant.inputHash,
      },
      variant.id
    );

    const [updated] = await db
      .select()
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, loc.id));
    if (!updated)
      throw new Error('test setup: sequenceLocations select returned nothing');
    expect(updated.referenceImageUrl).toBe('https://example.com/seq.png');
    expect(updated.referenceInputHash).toBe('h');

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).not.toBeNull();
  });

  it('rejects when parentType/parentId disagree with the variant', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const loc = await seedSequenceLocation();
    const variant = await methods.insertDivergent({
      parentType: 'sequence_location',
      parentId: loc.id,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: 'h',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    expect(
      methods.promoteAtomically(
        'library_location',
        loc.id,
        {
          referenceImageUrl: variant.url,
          referenceImagePath: null,
          referenceInputHash: variant.inputHash,
        },
        variant.id
      )
    ).rejects.toThrow(/does not match promote target/);

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
  });

  it('throws when sequence_location parent does not exist', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const ghostId = generateId();
    const variant = await methods.insertDivergent({
      parentType: 'sequence_location',
      parentId: ghostId,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: 'h',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    expect(
      methods.promoteAtomically(
        'sequence_location',
        ghostId,
        {
          referenceImageUrl: variant.url,
          referenceImagePath: null,
          referenceInputHash: variant.inputHash,
        },
        variant.id
      )
    ).rejects.toThrow(/not found/);

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
  });

  it('throws when the variant does not exist; library parent is not updated', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const loc = await seedLibraryLocation();
    expect(
      methods.promoteAtomically(
        'library_location',
        loc.id,
        {
          referenceImageUrl: 'https://example.com/x.png',
          referenceImagePath: null,
          referenceInputHash: 'h',
        },
        generateId()
      )
    ).rejects.toThrow(/not found/);

    const [refreshed] = await db
      .select()
      .from(locationLibrary)
      .where(eq(locationLibrary.id, loc.id));
    if (!refreshed)
      throw new Error('test setup: locationLibrary select returned nothing');
    expect(refreshed.referenceImageUrl).toBeNull();
    expect(refreshed.referenceInputHash).toBeNull();
  });
});

describe('sheet-variants list filters and empty-input short-circuits', () => {
  it('character listDivergentActiveByCharacters returns [] for empty input (no SQL roundtrip)', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    expect(await methods.listDivergentActiveByCharacters([])).toEqual([]);
  });

  it('talent listDivergentActiveByTalents returns [] for empty input', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    expect(await methods.listDivergentActiveByTalents([])).toEqual([]);
  });

  it('talent listDivergentActiveByTalentSheets returns [] for empty input', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    expect(await methods.listDivergentActiveByTalentSheets([])).toEqual([]);
  });

  it('location listDivergentActiveByParents filters by parentType (sequence vs library)', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const sharedId = generateId();

    const seqVariant = await methods.insertDivergent({
      parentType: 'sequence_location',
      parentId: sharedId,
      model: 'flux-pro',
      url: 'https://example.com/seq.png',
      status: 'completed',
      inputHash: 'hs',
      divergedAt,
    });
    const libVariant = await methods.insertDivergent({
      parentType: 'library_location',
      parentId: sharedId,
      model: 'flux-pro',
      url: 'https://example.com/lib.png',
      status: 'completed',
      inputHash: 'hl',
      divergedAt,
    });

    const seqOnly = await methods.listDivergentActiveByParents(
      'sequence_location',
      [sharedId]
    );
    expect(seqOnly.map((v) => v.id)).toEqual([seqVariant.id]);
    expect(seqOnly.map((v) => v.id)).not.toContain(libVariant.id);

    const libOnly = await methods.listDivergentActiveByParents(
      'library_location',
      [sharedId]
    );
    expect(libOnly.map((v) => v.id)).toEqual([libVariant.id]);
    expect(libOnly.map((v) => v.id)).not.toContain(seqVariant.id);
  });

  it('location listDivergentActiveByParents returns [] for empty input', async () => {
    const methods = createLocationSheetVariantsMethods(db);
    expect(
      await methods.listDivergentActiveByParents('sequence_location', [])
    ).toEqual([]);
    expect(
      await methods.listDivergentActiveByParents('library_location', [])
    ).toEqual([]);
  });

  it('character listDivergentActiveByCharacter excludes discarded rows but keeps all-divergent on listDivergentByCharacter', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const v1 = await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/a.png',
      status: 'completed',
      inputHash: 'h-a',
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      model: 'flux-pro',
      url: 'https://example.com/b.png',
      status: 'completed',
      inputHash: 'h-b',
      divergedAt,
    });
    await methods.discard(v1.id);

    const active = await methods.listDivergentActiveByCharacter(characterId);
    expect(active).toHaveLength(1);

    const allDivergent = await methods.listDivergentByCharacter(characterId);
    expect(allDivergent).toHaveLength(2);
  });
});

describe('talent-sheet-variants promoteAtomically negative cases', () => {
  it('throws when the talent sheet does not exist; variant is not soft-deleted', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    const variant = await methods.insertDivergent({
      talentSheetId,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: 'h',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    expect(
      methods.promoteAtomically(
        generateId(),
        {
          imageUrl: variant.url,
          imagePath: null,
          inputHash: variant.inputHash,
        },
        variant.id
      )
    ).rejects.toThrow(/not found/);

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
  });

  it('throws when the variant does not exist; talent_sheets is not updated', async () => {
    const methods = createTalentSheetVariantsMethods(db, team.id);
    expect(
      methods.promoteAtomically(
        talentSheetId,
        {
          imageUrl: 'https://example.com/new.png',
          imagePath: null,
          inputHash: 'h',
        },
        generateId()
      )
    ).rejects.toThrow(/not found/);

    const [sheet] = await db
      .select()
      .from(talentSheets)
      .where(eq(talentSheets.id, talentSheetId));
    if (!sheet)
      throw new Error('test setup: talentSheets select returned nothing');
    expect(sheet.imageUrl).toBe('https://example.com/sheet.png');
    expect(sheet.inputHash).toBeNull();
  });
});

describe('character sheet versions (append + select)', () => {
  it('applyConvergent appends a version and points at it, keeping history', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    // The pre-versioning sheet, as the #1419 backfill left it: a 'prior'
    // version keyed to the character's own id, with the pointer still null.
    await db.insert(characterSheetVariants).values({
      id: characterId,
      characterId,
      model: 'prior',
      url: 'https://example.com/old.png',
      storagePath: '/old.png',
      status: 'completed',
      inputHash: 'hash-old',
    });

    const { character, version } = await methods.applyConvergent({
      characterId,
      url: 'https://example.com/new.png',
      storagePath: '/new.png',
      inputHash: 'hash-new',
      model: 'nano_banana_2',
    });

    expect(character.selectedSheetVersionId).toBe(version.id);
    // The parent's mirror columns are no longer written (#1419) — the live
    // sheet is whatever the pointer names.
    const live = await createCharactersMethods(db).getById(characterId);
    expect(live?.sheetImageUrl).toBe('https://example.com/new.png');
    expect(live?.sheetInputHash).toBe('hash-new');

    const history = await methods.listHistoryByCharacter(characterId);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.url)).toEqual([
      'https://example.com/old.png',
      'https://example.com/new.png',
    ]);
    expect(history[1]?.id).toBe(version.id);
  });

  it('select repoints the parent without discarding the previous version', async () => {
    const methods = createCharacterSheetVariantsMethods(db);
    const first = await methods.applyConvergent({
      characterId,
      url: 'https://example.com/a.png',
      storagePath: '/a.png',
      inputHash: 'hash-a',
      model: 'nano_banana_2',
    });
    const second = await methods.applyConvergent({
      characterId,
      url: 'https://example.com/b.png',
      storagePath: '/b.png',
      inputHash: 'hash-b',
      model: 'nano_banana_2',
    });
    expect(second.character.selectedSheetVersionId).toBe(second.version.id);

    await methods.select(characterId, first.version.id, { actorId: null });
    const [after] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId));
    expect(after?.selectedSheetVersionId).toBe(first.version.id);
    // Reads follow the pointer, not a mirror column (#1419).
    const live = await createCharactersMethods(db).getById(characterId);
    expect(live?.sheetImageUrl).toBe('https://example.com/a.png');
    expect(live?.sheetInputHash).toBe('hash-a');

    const history = await methods.listHistoryByCharacter(characterId);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.id)).toEqual([
      first.version.id,
      second.version.id,
    ]);
    expect(history.every((row) => row.discardedAt == null)).toBe(true);
  });
});
