/**
 * Registering an organization's gateway app (docs/architecture/model-gateway.md
 * § Apps and user-pays). Either links a client the user already created, or
 * creates a public PKCE client through Better Auth's own registration first.
 */

import { OAUTH_SCOPES } from '@/platform/server/auth/oauth-scopes';
import { getAuth } from '@/platform/server/auth/config';
import {
  AuthorizationError,
  ConflictError,
  ValidationError,
} from '@/platform/errors';
import {
  getUserOrganizationMembership,
  type ScopedDb,
} from '@/platform/server/db/scoped';
import type { GatewayApp } from '@/platform/server/db/schema';

/** One app as Settings lists it. */
export type GatewayAppSummary = Pick<
  GatewayApp,
  'id' | 'name' | 'oauthClientId' | 'status' | 'createdAt'
>;

export function toGatewayAppSummary(app: GatewayApp): GatewayAppSummary {
  return {
    id: app.id,
    name: app.name,
    oauthClientId: app.oauthClientId,
    status: app.status,
    createdAt: app.createdAt,
  };
}

function isLoopbackOrCustomScheme(uri: string): boolean {
  const url = new URL(uri);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** A public PKCE client owned by the signed-in user; its client id. */
async function createPublicClient(input: {
  headers: Headers;
  name: string;
  redirectUris: string[];
}): Promise<string> {
  const native = input.redirectUris.some(isLoopbackOrCustomScheme);
  const created = await getAuth().api.createOAuthClient({
    headers: input.headers,
    body: {
      client_name: input.name,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: native ? 'native' : 'web',
      scope: OAUTH_SCOPES.join(' '),
    },
  });
  return created.client_id;
}

export async function registerGatewayApp(input: {
  scopedDb: ScopedDb;
  headers: Headers;
  name: string;
  /** A client the user created; omitted, a new public client is created. */
  clientId?: string;
  redirectUris?: string[];
}): Promise<GatewayAppSummary> {
  const { scopedDb } = input;
  const membership = await getUserOrganizationMembership(
    scopedDb.userId,
    scopedDb.organizationId
  );
  if (membership?.role !== 'owner' && membership?.role !== 'admin') {
    throw new AuthorizationError(
      'Only an owner or admin can register an app for this organization.'
    );
  }
  let clientId = input.clientId;
  if (!clientId) {
    if (!input.redirectUris?.length) {
      throw new ValidationError('Add at least one redirect URI.');
    }
    clientId = await createPublicClient({
      headers: input.headers,
      name: input.name,
      redirectUris: input.redirectUris,
    });
  }
  const result = await scopedDb.gatewayApps.register({
    oauthClientId: clientId,
    name: input.name,
  });
  if (result.ok) return toGatewayAppSummary(result.app);
  if (result.reason === 'taken') {
    throw new ConflictError('That client is already registered as an app.');
  }
  throw new AuthorizationError(
    'You can register only an OAuth client you created yourself.'
  );
}
