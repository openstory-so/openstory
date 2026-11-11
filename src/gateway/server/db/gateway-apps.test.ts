/**
 * App registration on the real migrations: only a client the user created
 * can be linked, once, and the submit's lookup finds it from any payer.
 */

import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  gatewayApps,
  oauthClient,
  organization,
  user,
} from '@/platform/server/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayAppsMethods } from './gateway-apps';

let db: Database;
let closeDb: () => Promise<void>;
const userId = generateId();
const strangerId = generateId();
const organizationId = generateId();
const payerOrganizationId = generateId();

async function client(clientId: string, owner: string | null) {
  await db.insert(oauthClient).values({
    id: generateId(),
    clientId,
    userId: owner,
    redirectUris: ['https://app.example/cb'],
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values([
    { id: userId, name: 'U', email: 'u@e.com' },
    { id: strangerId, name: 'S', email: 's@e.com' },
  ]);
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: payerOrganizationId, name: 'P', slug: 'p' },
  ]);
  await client('mine', userId);
  await client('theirs', strangerId);
  await client('dynamic', null);
});

afterAll(async () => {
  await closeDb();
});

describe('gatewayApps', () => {
  const apps = () => createGatewayAppsMethods(db, organizationId, userId);

  it('registers a client the user created', async () => {
    const result = await apps().register({ oauthClientId: 'mine', name: 'A' });
    expect(result).toMatchObject({
      ok: true,
      app: {
        organizationId,
        oauthClientId: 'mine',
        name: 'A',
        status: 'active',
        createdByUserId: userId,
      },
    });
    expect((await apps().list()).map((app) => app.oauthClientId)).toEqual([
      'mine',
    ]);
  });

  it("cannot claim another user's client or an unowned one", async () => {
    expect(
      await apps().register({ oauthClientId: 'theirs', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(
      await apps().register({ oauthClientId: 'dynamic', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(
      await apps().register({ oauthClientId: 'unknown', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(await db.select().from(gatewayApps)).toHaveLength(1);
  });

  it('cannot register a client twice, from any organization', async () => {
    const elsewhere = createGatewayAppsMethods(db, payerOrganizationId, userId);
    expect(
      await elsewhere.register({ oauthClientId: 'mine', name: 'Again' })
    ).toEqual({ ok: false, reason: 'taken' });
  });

  it("finds a client's app from the payer's scope", async () => {
    const payer = createGatewayAppsMethods(db, payerOrganizationId, strangerId);
    expect(await payer.getByOAuthClient('mine')).toMatchObject({
      organizationId,
      status: 'active',
    });
    expect(await payer.getByOAuthClient('theirs')).toBeNull();
    expect(await payer.list()).toEqual([]);
  });
});
