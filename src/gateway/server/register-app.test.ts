/**
 * Registering an app: owners and admins only, a new client goes through
 * Better Auth's own registration, and another user's client is refused.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  member,
  oauthClient,
  organization,
  user,
} from '@/platform/server/db/schema';

let db: Database;
let closeDb: () => Promise<void>;

const createOAuthClient = vi.fn(
  async (input: { body: { client_name: string; redirect_uris: string[] } }) => {
    const clientId = generateId();
    await db.insert(oauthClient).values({
      id: generateId(),
      clientId,
      userId: ownerId,
      name: input.body.client_name,
      redirectUris: input.body.redirect_uris,
    });
    return { client_id: clientId };
  }
);

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/auth/config', () => ({
  getAuth: () => ({ api: { createOAuthClient } }),
}));

const { registerGatewayApp } = await import('./register-app');
const { createScopedDb } = await import('@/platform/server/db/scoped');

const organizationId = generateId();
const ownerId = generateId();
const memberId = generateId();

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values([
    { id: ownerId, name: 'O', email: 'o@e.com' },
    { id: memberId, name: 'M', email: 'm@e.com' },
  ]);
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
  await db.insert(member).values([
    {
      id: generateId(),
      organizationId,
      userId: ownerId,
      role: 'owner',
      createdAt: new Date(),
    },
    {
      id: generateId(),
      organizationId,
      userId: memberId,
      role: 'member',
      createdAt: new Date(),
    },
  ]);
  await db.insert(oauthClient).values({
    id: generateId(),
    clientId: 'members-client',
    userId: memberId,
    redirectUris: ['https://m.example/cb'],
  });
});

afterAll(async () => {
  await closeDb();
});

describe('registerGatewayApp', () => {
  it('creates a public PKCE client and registers it', async () => {
    const app = await registerGatewayApp({
      scopedDb: createScopedDb(organizationId, ownerId),
      headers: new Headers(),
      name: 'Acme',
      redirectUris: ['https://acme.example/cb', 'http://127.0.0.1:8765/cb'],
    });
    expect(app).toMatchObject({ name: 'Acme', status: 'active' });
    expect(createOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          token_endpoint_auth_method: 'none',
          application_type: 'native',
          redirect_uris: [
            'https://acme.example/cb',
            'http://127.0.0.1:8765/cb',
          ],
        }),
      })
    );
  });

  it("refuses another user's client", async () => {
    await expect(
      registerGatewayApp({
        scopedDb: createScopedDb(organizationId, ownerId),
        headers: new Headers(),
        name: 'Stolen',
        clientId: 'members-client',
      })
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR' });
  });

  it('refuses a plain member', async () => {
    await expect(
      registerGatewayApp({
        scopedDb: createScopedDb(organizationId, memberId),
        headers: new Headers(),
        name: 'Mine',
        clientId: 'members-client',
      })
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR' });
  });
});
