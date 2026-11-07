/**
 * `cleanupTestUser` deletes an organization with characters, looks, locations
 * and dialogue (#2296): nothing cascades from a character or a location.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import {
  dialogueSpeeches,
  organization,
  shotDialogueVersions,
} from '@/platform/server/db/schema';
import { createCharactersMethods } from '@/cast/server/db/characters';
import { createCharacterLooksMethods } from '@/cast/server/db/character-looks';
import { createLocationsMethods } from '@/cast/server/db/locations';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';

let db: Database;
let closeDb: () => Promise<void>;
vi.doMock('#db-client', () => ({ getDb: () => db }));
const { cleanupTestUser, createTestShot, createTestSequence, createTestUser } =
  await import('./seed');

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});
afterAll(async () => {
  await closeDb();
});

const tables = async () =>
  (
    await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrations%'`
    )
  ).map((row) => row.name);

const rowCounts = async () => {
  const counts: Record<string, number> = {};
  for (const name of await tables()) {
    const [row] = await db.all<{ n: number }>(
      sql.raw(`SELECT count(*) AS n FROM "${name}"`)
    );
    if (row && row.n > 0) counts[name] = row.n;
  }
  return counts;
};

describe('cleanupTestUser', () => {
  it('deletes the organization with its characters, looks, locations and dialogue', async () => {
    const before = await rowCounts();
    const user = await createTestUser();
    const { organizationId } = user;
    const sequence = await createTestSequence(organizationId, user.id);
    const shot = await createTestShot(sequence.id, 0);

    const chars = createCharactersMethods(db, organizationId);
    const cast = await chars.create(
      {
        sequenceId: sequence.id,
        characterId: 'char_001',
        name: 'Ada',
        rendering: PHOTOREAL_RENDERING,
      },
      { source: 'analysis', createdBy: null }
    );
    await createCharacterLooksMethods(db, organizationId).create(
      sequence.id,
      cast.id,
      { name: 'Gala', clothing: 'gown', styling: '' },
      { source: 'edit', actorId: user.id }
    );
    // Made on the Characters page: no sequence holds it.
    await chars.createForOrganization(
      { name: 'Bea', rendering: PHOTOREAL_RENDERING, standardClothing: null },
      { createdBy: user.id }
    );

    const locs = createLocationsMethods(db, organizationId);
    await locs.create(
      {
        sequenceId: sequence.id,
        locationId: 'loc_001',
        name: 'Kitchen',
        rendering: PHOTOREAL_RENDERING,
      },
      { source: 'analysis', createdBy: null }
    );
    await locs.createForOrganization(
      { name: 'Hall', rendering: PHOTOREAL_RENDERING },
      { createdBy: user.id }
    );

    await db.insert(shotDialogueVersions).values({
      shotId: shot.id,
      lines: [],
      source: 'user-edit',
      createdBy: user.id,
    });
    await db.insert(dialogueSpeeches).values({
      sequenceId: sequence.id,
      storageKey: 'b/k.wav',
      url: '/r2/k.wav',
      durationSeconds: 1,
      turns: [],
      inputHash: 'h',
      characterCount: 1,
    });

    await cleanupTestUser(user.id, organizationId);

    expect(
      await db
        .select()
        .from(organization)
        .where(eq(organization.id, organizationId))
    ).toEqual([]);
    expect(await rowCounts()).toEqual(before);
  });
});
