/**
 * Legacy `team_members` rows are copied onto Better Auth `member` (#813).
 * A user with one membership reuses their user id. More than one gets a new id.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
import {
  member,
  organization,
  teamMembers,
  user,
} from '@/platform/server/db/schema';

let db: Database;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  closeDb = testDb.close;
});

afterAll(async () => {
  await closeDb();
});

vi.doMock('#db-client', () => ({ getDb: () => db }));

const { resolveUserTeam } = await import('@/platform/server/db/scoped');

async function seedUser(userId: string) {
  await db.insert(user).values({
    id: userId,
    name: 'Member',
    email: `${userId}@example.com`,
  });
}

describe('resolveUserTeam membership heal (#813)', () => {
  it('reuses the user id when they belong to one organization', async () => {
    const userId = generateId();
    const organizationId = generateId();
    await seedUser(userId);
    await db.insert(organization).values({
      id: organizationId,
      name: 'Only',
      slug: `only-${userId.slice(0, 8)}`,
    });
    await db.insert(teamMembers).values({
      organizationId,
      userId,
      role: 'owner',
      joinedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const resolved = await resolveUserTeam(userId);
    expect(resolved).toMatchObject({
      organizationId,
      role: 'owner',
      teamName: 'Only',
    });
    const rows = await db
      .select()
      .from(member)
      .where(eq(member.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(userId);
    expect(rows[0]?.createdAt).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('gives each extra membership its own id and honors the active organization', async () => {
    const userId = generateId();
    const ownerOrg = generateId();
    const viewerOrg = generateId();
    await seedUser(userId);
    await db.insert(organization).values([
      { id: ownerOrg, name: 'Owned', slug: `owned-${userId.slice(0, 8)}` },
      { id: viewerOrg, name: 'Watched', slug: `watched-${userId.slice(0, 8)}` },
    ]);
    await db.insert(teamMembers).values([
      { organizationId: ownerOrg, userId, role: 'owner' },
      { organizationId: viewerOrg, userId, role: 'viewer' },
    ]);

    const highest = await resolveUserTeam(userId);
    expect(highest).toMatchObject({ organizationId: ownerOrg, role: 'owner' });

    const active = await resolveUserTeam(userId, viewerOrg);
    expect(active).toMatchObject({
      organizationId: viewerOrg,
      role: 'viewer',
      teamName: 'Watched',
    });

    const rows = await db
      .select()
      .from(member)
      .where(eq(member.userId, userId));
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(userId);
  });
});
