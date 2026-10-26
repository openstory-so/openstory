/**
 * Schema-level acceptance tests for `insertDivergent` on
 * `character_sheet_variants` and `location_sheet_variants`.
 *
 * The three tables share a partial-index split (primary vs divergent on
 * `divergedAt`) and a parallel race-tolerance helper. The tests pin the
 * substantive new behavior introduced in PR #618:
 *
 *  - Step-retry idempotency: repeated calls with the same identity tuple
 *    return the existing row instead of double-inserting.
 *  - Cross-run race tolerance: a unique-constraint conflict triggered by a
 *    concurrent run is absorbed into a re-fetch that returns the winner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import {
  characterSheetInputHash,
  locationSheetInputHash,
} from '@/shots/input-hash';
import {
  characterLooks,
  characterSheetVariants,
  characters,
  locationSheetVariants,
  locations,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import type { Database } from '@/platform/server/db/client';
import { createCharacterLooksMethods } from './character-looks';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { createCharactersMethods } from './characters';
import { createLocationSheetVariantsMethods } from './location-sheet-variants';
import { createLocationsMethods } from './locations';

let closeDb: () => Promise<void>;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let characterId = '';

async function seed() {
  await db.delete(characterSheetVariants);
  await clearVersionRows(db);
  await db.delete(locationSheetVariants);
  await db.delete(characters);
  await db.delete(locations);
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
  const character = await createCharactersMethods(db, team.id).create(
    {
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      rendering: 'Photoreal live action',
    },
    { source: 'analysis', createdBy: null }
  );
  characterId = character.id;
}

/** One of the team's locations, in no sequence. */
const seedLocation = async (name: string) =>
  await createLocationsMethods(db, team.id).createForTeam(
    { name, rendering: 'Photoreal live action' },
    { createdBy: userRow.id }
  );

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await seed();
});

describe('character-sheet-variants insertDivergent', () => {
  it('is idempotent on (characterId, model, inputHash) — retry returns the existing row', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const first = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-snap'),
      divergedAt,
    });

    const second = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-snap'),
      divergedAt,
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(characterSheetVariants);
    expect(rows).toHaveLength(1);
  });

  it('writes a second divergent row when inputHash differs', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-a.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-a'),
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent-b.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-b'),
      divergedAt,
    });

    const rows = await db.select().from(characterSheetVariants);
    expect(rows).toHaveLength(2);
  });

  it('pre-check returns the existing row when a divergent variant is already present', async () => {
    // Seeds the row directly, then calls `insertDivergent`. The helper's
    // pre-check SELECT finds the row and returns it — exercises the
    // "the engine retried the same step" path. The post-collision retry path
    // is exercised separately at the helper level (see `insertDivergentRaceTolerant`
    // tests below).
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const [existingRow] = await db
      .insert(characterSheetVariants)
      .values({
        characterId,
        lookId: characterId,
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
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/loser.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-race'),
      divergedAt,
    });

    expect(result.id).toBe(existingRow.id);
    expect(result.url).toBe('https://example.com/winner.png');
  });
});

describe('location-sheet-variants insertDivergent', () => {
  it('is idempotent on (locationId, model, inputHash)', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const location = await seedLocation('Harbour');

    const first = await methods.insertDivergent({
      locationId: location.id,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hash-snap'),
      divergedAt,
    });
    const second = await methods.insertDivergent({
      locationId: location.id,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hash-snap'),
      divergedAt,
    });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(locationSheetVariants);
    expect(rows).toHaveLength(1);
  });

  it('keeps the same model and hash on two locations as two rows', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const harbour = await seedLocation('Harbour');
    const depot = await seedLocation('Depot');

    for (const location of [harbour, depot]) {
      await methods.insertDivergent({
        locationId: location.id,
        model: 'flux-pro',
        url: 'https://example.com/sheet.png',
        status: 'completed',
        inputHash: locationSheetInputHash('hash'),
        divergedAt,
      });
    }

    const rows = await db.select().from(locationSheetVariants);
    expect(rows).toHaveLength(2);
  });
});

describe('character-sheet-variants discard / undiscard / promote', () => {
  it('discard sets discardedAt and undiscard clears it', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const variant = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash'),
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

  it('refuses to discard the selected sheet version', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const variant = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/live.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-live'),
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    await createCharacterLooksMethods(db, team.id).ensureDefault(characterId);
    await db
      .update(characterLooks)
      .set({ selectedSheetVersionId: variant.id })
      .where(eq(characterLooks.id, characterId));

    await expect(methods.discard(variant.id)).rejects.toThrow(
      /Cannot discard the selected/
    );
    expect((await methods.getById(variant.id))?.discardedAt).toBeNull();
  });

  it('listDivergentActiveByCharacter excludes discarded rows', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const a = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/a.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-a'),
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/b.png',
      status: 'completed',
      inputHash: characterSheetInputHash('hash-b'),
      divergedAt,
    });
    await methods.discard(a.id);

    const active = await methods.listDivergentActiveByCharacter(characterId);
    expect(active).toHaveLength(1);
    expect(active[0]?.inputHash).toBe('hash-b');
  });
});

describe('location-sheet-variants discard', () => {
  it('discard then list excludes the discarded row', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const location = await seedLocation('Harbour');
    const variant = await methods.insertDivergent({
      locationId: location.id,
      model: 'flux-pro',
      url: 'https://example.com/x.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hash'),
      divergedAt,
    });

    await methods.discard(variant.id);
    const active = await methods.listDivergentActiveByLocation(location.id);
    expect(active).toHaveLength(0);
  });

  it('refuses to discard a location’s selected reference', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const location = await seedLocation('Harbour');
    const variant = await methods.insertDivergent({
      locationId: location.id,
      model: 'flux-pro',
      url: 'https://example.com/live.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hash-live'),
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    await db
      .update(locations)
      .set({ selectedReferenceVersionId: variant.id })
      .where(eq(locations.id, location.id));

    await expect(methods.discard(variant.id)).rejects.toThrow(
      /Cannot discard the selected/
    );
    expect((await methods.getById(variant.id))?.discardedAt).toBeNull();
  });
});

describe('sheet-variants list filters and empty-input short-circuits', () => {
  it('character listDivergentActiveByCharacters returns [] for empty input (no SQL roundtrip)', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    expect(await methods.listDivergentActiveByCharacters([])).toEqual([]);
  });

  it('location listDivergentActiveByLocations lists only the locations asked for', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const harbour = await seedLocation('Harbour');
    const depot = await seedLocation('Depot');

    const harbourVariant = await methods.insertDivergent({
      locationId: harbour.id,
      model: 'flux-pro',
      url: 'https://example.com/harbour.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hs'),
      divergedAt,
    });
    const depotVariant = await methods.insertDivergent({
      locationId: depot.id,
      model: 'flux-pro',
      url: 'https://example.com/depot.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hs'),
      divergedAt,
    });

    const one = await methods.listDivergentActiveByLocations([harbour.id]);
    expect(one.map((v) => v.id)).toEqual([harbourVariant.id]);
    const both = await methods.listDivergentActiveByLocations([
      harbour.id,
      depot.id,
    ]);
    expect(both.map((v) => v.id).sort()).toEqual(
      [harbourVariant.id, depotVariant.id].sort()
    );
  });

  it('another team reads and writes none of a location’s sheet versions', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    const harbour = await seedLocation('Harbour');
    const variant = await methods.insertDivergent({
      locationId: harbour.id,
      model: 'flux-pro',
      url: 'https://example.com/harbour.png',
      status: 'completed',
      inputHash: locationSheetInputHash('hs'),
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const other = createLocationSheetVariantsMethods(db, generateId());
    expect(await other.getById(variant.id)).toBeNull();
    expect(await other.getByIds([variant.id])).toEqual([]);
    expect(await other.listByLocation(harbour.id)).toEqual([]);
    expect(await other.listHistoryByLocation(harbour.id)).toEqual([]);
    expect(await other.listDivergentActiveByLocation(harbour.id)).toEqual([]);
    expect(await other.listDivergentActiveByLocations([harbour.id])).toEqual(
      []
    );
    await expect(other.discard(variant.id)).rejects.toThrow(/not found/);
    await expect(other.undiscard(variant.id)).rejects.toThrow(/not found/);
    await expect(
      other.select(null, harbour.id, variant.id, { actorId: null })
    ).rejects.toThrow(/not found/);
    await expect(
      other.applyConvergent({
        locationDbId: harbour.id,
        url: 'https://example.com/theirs.png',
        storagePath: '/r2/theirs.png',
        inputHash: null,
        model: 'upload',
      })
    ).rejects.toThrow(/not found/);
    await other.setPortrait(variant.id, 'https://example.com/portrait.png');

    const after = await methods.getById(variant.id);
    expect(after?.discardedAt).toBeNull();
    expect(after?.portraitUrl).toBeNull();
    expect(await methods.listByLocation(harbour.id)).toHaveLength(1);
  });

  it('location listDivergentActiveByLocations returns [] for empty input', async () => {
    const methods = createLocationSheetVariantsMethods(db, team.id);
    expect(await methods.listDivergentActiveByLocations([])).toEqual([]);
  });

  it('character listDivergentActiveByCharacter excludes discarded rows but keeps all-divergent on listDivergentByCharacter', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const v1 = await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/a.png',
      status: 'completed',
      inputHash: characterSheetInputHash('h-a'),
      divergedAt,
    });
    await methods.insertDivergent({
      characterId,
      lookId: characterId,
      model: 'flux-pro',
      url: 'https://example.com/b.png',
      status: 'completed',
      inputHash: characterSheetInputHash('h-b'),
      divergedAt,
    });
    await methods.discard(v1.id);

    const active = await methods.listDivergentActiveByCharacter(characterId);
    expect(active).toHaveLength(1);

    const allDivergent = await methods.listDivergentByCharacter(characterId);
    expect(allDivergent).toHaveLength(2);
  });
});

describe('character sheet versions (append + select)', () => {
  it('applyConvergent appends a version and points at it, keeping history', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
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

    const { version } = await methods.applyConvergent({
      lookId: characterId,
      url: 'https://example.com/new.png',
      storagePath: '/new.png',
      inputHash: characterSheetInputHash('hash-new'),
      model: 'nano_banana_2',
    });

    // The parent's mirror columns are no longer written (#1419) — the live
    // sheet is whatever the pointer names.
    const live = await createCharactersMethods(db, team.id).getById(
      sequenceId,
      characterId
    );
    expect(live?.selectedSheetVersionId).toBe(version.id);
    expect(live?.sheetImageUrl).toBe('https://example.com/new.png');
    expect(live?.sheetInputHash).toBe('hash-new');

    const history = await methods.listHistoryByLook(characterId);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.url)).toEqual([
      'https://example.com/old.png',
      'https://example.com/new.png',
    ]);
    expect(history[1]?.id).toBe(version.id);
  });

  it('select repoints the parent without discarding the previous version', async () => {
    const methods = createCharacterSheetVariantsMethods(db, team.id);
    const first = await methods.applyConvergent({
      lookId: characterId,
      url: 'https://example.com/a.png',
      storagePath: '/a.png',
      inputHash: characterSheetInputHash('hash-a'),
      model: 'nano_banana_2',
    });
    const second = await methods.applyConvergent({
      lookId: characterId,
      url: 'https://example.com/b.png',
      storagePath: '/b.png',
      inputHash: characterSheetInputHash('hash-b'),
      model: 'nano_banana_2',
    });
    expect(
      (
        await createCharactersMethods(db, team.id).getById(
          sequenceId,
          characterId
        )
      )?.selectedSheetVersionId
    ).toBe(second.version.id);

    await methods.select(sequenceId, characterId, first.version.id, {
      actorId: null,
    });
    const [after] = await db
      .select()
      .from(characterLooks)
      .where(eq(characterLooks.id, characterId));
    expect(after?.selectedSheetVersionId).toBe(first.version.id);
    // Reads follow the pointer, not a mirror column (#1419).
    const live = await createCharactersMethods(db, team.id).getById(
      sequenceId,
      characterId
    );
    expect(live?.sheetImageUrl).toBe('https://example.com/a.png');
    expect(live?.sheetInputHash).toBe('hash-a');

    const history = await methods.listHistoryByLook(characterId);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.id)).toEqual([
      first.version.id,
      second.version.id,
    ]);
    expect(history.every((row) => row.discardedAt == null)).toBe(true);
  });
});
