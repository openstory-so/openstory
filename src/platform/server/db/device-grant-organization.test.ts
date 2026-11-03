/** The organization picked on /device reaches the key minted at exchange (#813). */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
import { deviceCode, organization, user } from '@/platform/server/db/schema';

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

const { getDeviceGrantOrganizationId, recordDeviceGrantOrganization } =
  await import('@/platform/server/db/scoped');

describe('device grant organization', () => {
  it('reads the approved organization by device code until the code is consumed', async () => {
    const userId = generateId();
    const organizationId = generateId();
    const codeId = generateId();
    await db
      .insert(user)
      .values({ id: userId, name: 'Ada', email: `${userId}@example.com` });
    await db
      .insert(organization)
      .values({ id: organizationId, name: 'Acme', slug: `acme-${userId}` });
    await db.insert(deviceCode).values({
      id: codeId,
      deviceCode: 'secret-device-code',
      userCode: 'ABCDEFGH',
      userId,
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await getDeviceGrantOrganizationId('secret-device-code')).toBeNull();
    await recordDeviceGrantOrganization({
      userCode: 'ABCDEFGH',
      userId,
      organizationId,
    });
    expect(await getDeviceGrantOrganizationId('secret-device-code')).toBe(
      organizationId
    );

    await db.delete(deviceCode).where(eq(deviceCode.id, codeId));
    expect(await getDeviceGrantOrganizationId('secret-device-code')).toBeNull();
  });
});
