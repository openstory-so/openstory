/**
 * `cleanupTestUser` deletes the organization even when it owns rows that
 * refuse that delete: characters with no cast link (#2296), generated assets
 * and stitches.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import {
  characterLooks,
  characters,
  generatedAssets,
  organization,
  sequenceCast,
  stitches,
  user,
} from '@/platform/server/db/schema';

let db: Database;
let closeDb: () => Promise<void>;

vi.doMock('#db-client', () => ({ getDb: () => db }));

const {
  cleanupTestUser,
  createScarlettTestCharacter,
  createTestCharacter,
  createTestSequence,
  createTestUser,
} = await import('./seed');

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(() => closeDb());

describe('cleanupTestUser', () => {
  it('deletes an organization with unlinked characters, assets and stitches', async () => {
    const created = await createTestUser();
    const sequence = await createTestSequence(
      created.organizationId,
      created.id
    );
    const cast = await createTestCharacter(sequence.id, 'char-1', 'Mara');
    // A replaced character: its cast link points at another character now.
    await db.delete(sequenceCast).where(eq(sequenceCast.id, cast.id));
    // A character from the Characters page: never linked.
    await createScarlettTestCharacter(created.organizationId);
    await db.insert(generatedAssets).values({
      organizationId: created.organizationId,
      userId: created.id,
      provider: 'fal',
      endpointId: 'fal-ai/flux-1/dev',
      activity: 'image',
      modelName: 'FLUX.1 [dev]',
      input: { prompt: 'a loft' },
    });
    await db.insert(stitches).values({
      organizationId: created.organizationId,
      userId: created.id,
      cut: {
        clips: [{ videoUrl: 'clip.mp4', posterUrl: null, cues: [] }],
        frameWidth: 1920,
        frameHeight: 1080,
        musicUrl: null,
        musicGainDb: 0,
      },
    });

    await cleanupTestUser(created.id, created.organizationId);

    expect(
      await db
        .select({ id: characters.id })
        .from(characters)
        .where(eq(characters.organizationId, created.organizationId))
    ).toEqual([]);
    expect(
      await db.select({ id: characterLooks.id }).from(characterLooks)
    ).toEqual([]);
    expect(
      await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, created.organizationId))
    ).toEqual([]);
    expect(
      await db.select({ id: user.id }).from(user).where(eq(user.id, created.id))
    ).toEqual([]);
  });
});
