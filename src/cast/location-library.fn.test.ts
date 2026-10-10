/**
 * Tests for location-library server functions, focusing on addLocationToLibrary (#1695).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  locationLibrary,
  locationSheets,
  locationSheetVariants,
  sequenceLocations,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';

let db: Database;

vi.doMock('#db-client', () => ({ getDb: () => db }));

const { createScopedDb } = await import('@/platform/server/db/scoped');
const { addLocationToLibrary } =
  await import('./server/locations/create-library-location');

let teamIdA = '';
let teamIdB = '';
let userIdA = '';
let userIdB = '';
let seqIdA = '';
let seqIdB = '';

const DEFAULT_STYLE_CONFIG = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

beforeAll(async () => {
  const client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

beforeEach(async () => {
  await db.delete(locationSheets);
  await db.delete(locationLibrary);
  await db.delete(locationSheetVariants);
  await db.delete(sequenceLocations);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamIdA = generateId();
  teamIdB = generateId();
  userIdA = generateId();
  userIdB = generateId();
  seqIdA = generateId();
  seqIdB = generateId();

  await db.insert(teams).values([
    { id: teamIdA, name: 'Team A', slug: 'team-a' },
    { id: teamIdB, name: 'Team B', slug: 'team-b' },
  ]);

  await db.insert(user).values([
    { id: userIdA, name: 'User A', email: 'a@example.com' },
    { id: userIdB, name: 'User B', email: 'b@example.com' },
  ]);

  const [styleA] = await db
    .insert(styles)
    .values({
      teamId: teamIdA,
      name: 'Style A',
      config: DEFAULT_STYLE_CONFIG,
    })
    .returning();
  if (!styleA) throw new Error('Style A insert failed');

  const [styleB] = await db
    .insert(styles)
    .values({
      teamId: teamIdB,
      name: 'Style B',
      config: DEFAULT_STYLE_CONFIG,
    })
    .returning();
  if (!styleB) throw new Error('Style B insert failed');

  await db.insert(sequences).values([
    { id: seqIdA, teamId: teamIdA, title: 'Seq A', styleId: styleA.id },
    { id: seqIdB, teamId: teamIdB, title: 'Seq B', styleId: styleB.id },
  ]);
});

describe('addLocationToLibrary (#1695)', () => {
  it('adds a sequence location with a reference image to the library and links libraryLocationId', async () => {
    const locId = generateId();
    const variantId = generateId();

    await db.insert(locationSheetVariants).values({
      id: variantId,
      parentId: locId,
      parentType: 'sequence_location',
      model: 'fal-ai/flux-1/dev',
      url: 'https://storage.openstory.so/locations/bar.png',
      storagePath: 'team-a/locations/bar.png',
      status: 'completed',
    });

    await db.insert(sequenceLocations).values({
      id: locId,
      sequenceId: seqIdA,
      locationId: 'loc_001',
      legacyName: 'Cyberpunk Bar',
      legacyDescription: 'Neon-lit futuristic dive bar',
      selectedReferenceVersionId: variantId,
      referenceStatus: 'completed',
    });

    const scopedDb = createScopedDb(teamIdA, userIdA);
    const result = await addLocationToLibrary(scopedDb, { locationId: locId });

    expect(result.id).toBeDefined();
    expect(result.name).toBe('Cyberpunk Bar');
    expect(result.description).toBe('Neon-lit futuristic dive bar');
    expect(result.referenceImageUrl).toBe(
      'https://storage.openstory.so/locations/bar.png'
    );
    expect(result.referenceImagePath).toBe('team-a/locations/bar.png');

    // Verify library location row was created in DB
    const libLocation = await scopedDb.locations.getById(result.id);
    expect(libLocation).not.toBeNull();
    expect(libLocation?.name).toBe('Cyberpunk Bar');
    expect(libLocation?.teamId).toBe(teamIdA);

    // Verify default sheet was created in location_sheets
    const sheets = await scopedDb.locationSheets.list(result.id);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.name).toBe('Default');
    expect(sheets[0]?.imageUrl).toBe(
      'https://storage.openstory.so/locations/bar.png'
    );
    expect(sheets[0]?.imagePath).toBe('team-a/locations/bar.png');
    expect(sheets[0]?.isDefault).toBe(true);
    expect(sheets[0]?.source).toBe('from_library');

    // Verify sequence location has libraryLocationId set
    const updatedSeqLoc = await scopedDb.sequenceLocations.getById(locId);
    expect(updatedSeqLoc?.libraryLocationId).toBe(result.id);
  });

  it('adds a sequence location without reference image without creating sheets', async () => {
    const locId = generateId();
    await db.insert(sequenceLocations).values({
      id: locId,
      sequenceId: seqIdA,
      locationId: 'loc_002',
      legacyName: 'Quiet Park',
      legacyDescription: 'Empty park bench under moonlight',
      referenceStatus: 'pending',
    });

    const scopedDb = createScopedDb(teamIdA, userIdA);
    const result = await addLocationToLibrary(scopedDb, { locationId: locId });

    expect(result.name).toBe('Quiet Park');
    expect(result.referenceImageUrl).toBeNull();

    const sheets = await scopedDb.locationSheets.list(result.id);
    expect(sheets).toHaveLength(0);

    const updatedSeqLoc = await scopedDb.sequenceLocations.getById(locId);
    expect(updatedSeqLoc?.libraryLocationId).toBe(result.id);
  });

  it('rejects adding a location belonging to another team (cross-team boundary)', async () => {
    const locIdB = generateId();
    await db.insert(sequenceLocations).values({
      id: locIdB,
      sequenceId: seqIdB,
      locationId: 'loc_b01',
      legacyName: 'Team B Secret Base',
      referenceStatus: 'completed',
    });

    // Team A tries to add Team B's location
    const scopedDbA = createScopedDb(teamIdA, userIdA);
    await expect(
      addLocationToLibrary(scopedDbA, { locationId: locIdB })
    ).rejects.toThrow();
  });

  it('throws when sequence location does not exist', async () => {
    const scopedDbA = createScopedDb(teamIdA, userIdA);
    await expect(
      addLocationToLibrary(scopedDbA, { locationId: generateId() })
    ).rejects.toThrow('Location not found');
  });
});
