/**
 * OAuth provider wiring (#1456): issuer resolution and the plugin options
 * that tie a grant to a team.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState: { VITE_APP_URL?: string } = {};
const resolveUserTeam = vi.fn();

vi.doMock('#env', () => ({ getEnv: () => envState }));
vi.doMock('@/lib/db/scoped', () => ({ resolveUserTeam }));

const {
  apiResourceIdentifier,
  createOAuthProviderPlugins,
  mcpResourceIdentifier,
  pickOAuthIssuer,
  resolveOAuthIssuer,
} = await import('./oauth-provider');
const { OAUTH_API_SCOPES, OAUTH_SCOPE_DESCRIPTIONS, OAUTH_SCOPES } =
  await import('./oauth-scopes');

type Plugins = ReturnType<typeof createOAuthProviderPlugins>;
type ProviderPlugin = Extract<Plugins[number], { id: 'oauth-provider' }>;

/** The `mcp()` plugin's resolved options (discriminated on the plugin id). */
function providerOptions(): ProviderPlugin['options'] {
  const provider = createOAuthProviderPlugins().find(
    (plugin): plugin is ProviderPlugin => plugin.id === 'oauth-provider'
  );
  if (!provider) throw new Error('oauth-provider plugin missing');
  return provider.options;
}

const now = new Date();
const user = {
  id: 'user_1',
  name: 'Ada',
  email: 'ada@example.com',
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const session = {
  id: 'sess_1',
  userId: user.id,
  token: 'tok',
  expiresAt: now,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  delete envState.VITE_APP_URL;
  resolveUserTeam.mockReset();
});

describe('resolveOAuthIssuer', () => {
  it('uses the app URL when it is HTTPS or loopback, without a trailing slash', () => {
    envState.VITE_APP_URL = 'https://openstory.so/';
    expect(resolveOAuthIssuer()).toBe('https://openstory.so');
    envState.VITE_APP_URL = 'http://localhost:3001';
    expect(resolveOAuthIssuer()).toBe('http://localhost:3001');
  });

  it('falls back to localhost when unset or a plain-HTTP LAN address', () => {
    expect(resolveOAuthIssuer()).toBe('http://localhost:3000');
    envState.VITE_APP_URL = 'http://192.168.1.20:3000';
    expect(resolveOAuthIssuer()).toBe('http://localhost:3000');
    envState.VITE_APP_URL = 'not a url';
    expect(resolveOAuthIssuer()).toBe('http://localhost:3000');
  });

  it('throws in production when the URL is missing, invalid, or plain HTTP', () => {
    expect(() => pickOAuthIssuer(undefined, false)).toThrow(/VITE_APP_URL/);
    expect(() => pickOAuthIssuer('not a url', false)).toThrow(/VITE_APP_URL/);
    expect(() => pickOAuthIssuer('http://192.168.1.20:3000', false)).toThrow(
      /VITE_APP_URL/
    );
    expect(pickOAuthIssuer('https://openstory.so', false)).toBe(
      'https://openstory.so'
    );
  });

  it('derives the resource identifiers from the issuer', () => {
    envState.VITE_APP_URL = 'https://openstory.so';
    expect(mcpResourceIdentifier()).toBe('https://openstory.so/mcp');
    expect(apiResourceIdentifier()).toBe('https://openstory.so/api/v1');
  });
});

describe('scopes', () => {
  it('describes every scope for the consent page', () => {
    for (const scope of OAUTH_SCOPES) {
      expect(OAUTH_SCOPE_DESCRIPTIONS[scope]).toBeTruthy();
    }
    for (const scope of OAUTH_API_SCOPES) {
      expect(OAUTH_SCOPES).toContain(scope);
    }
  });
});

describe('createOAuthProviderPlugins', () => {
  it('returns the jwt and oauth-provider plugins', () => {
    envState.VITE_APP_URL = 'https://openstory.so';
    const ids = createOAuthProviderPlugins().map((plugin) => plugin.id);
    expect(ids).toEqual(['jwt', 'oauth-provider']);
  });

  it('disables session JWT headers on the jwt plugin', () => {
    envState.VITE_APP_URL = 'https://openstory.so';
    const jwtPlugin = createOAuthProviderPlugins().find(
      (plugin) => plugin.id === 'jwt'
    );
    expect(jwtPlugin?.options.disableSettingJwtHeader).toBe(true);
  });

  it('disables the jwt plugin GET /token path on the auth config', () => {
    const source = readFileSync(
      new URL('./config.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/disabledPaths:\s*\[\s*'\/token'\s*\]/);
  });

  it('bills a grant to the user default team and stamps it on the token', async () => {
    envState.VITE_APP_URL = 'https://openstory.so';
    resolveUserTeam.mockResolvedValue({ teamId: 'team_1', teamName: 'T' });
    const options = providerOptions();

    const referenceId = await options.postLogin?.consentReferenceId({
      user,
      session,
      scopes: [],
    });
    expect(referenceId).toBe('team_1');
    expect(resolveUserTeam).toHaveBeenCalledWith('user_1');

    expect(
      await options.customAccessTokenClaims?.({
        referenceId: 'team_1',
        scopes: [],
      })
    ).toEqual({ team_id: 'team_1' });
    expect(await options.customAccessTokenClaims?.({ scopes: [] })).toEqual({});
    expect(
      await options.postLogin?.shouldRedirect({
        headers: new Headers(),
        user,
        session,
        scopes: [],
      })
    ).toBe(false);
  });

  it('declares the API as a resource every registered client may use', () => {
    envState.VITE_APP_URL = 'https://openstory.so';
    const options = providerOptions();
    const identifiers = (options.resources ?? []).map((resource) =>
      typeof resource === 'string' ? resource : resource.identifier
    );
    expect(identifiers).toContain('https://openstory.so/api/v1');
    expect(identifiers).toContain('https://openstory.so/mcp');
    expect(options.clientRegistrationDefaultResources).toContain(
      'https://openstory.so/api/v1'
    );
    expect(options.allowDynamicClientRegistration).toBe(true);
    expect(options.allowUnauthenticatedClientRegistration).toBe(true);
    expect(options.loginPage).toBe('/oauth/login');
    expect(options.consentPage).toBe('/oauth/consent-start');
    expect(options.postLogin?.page).toBe('/oauth/consent-start');
  });
});
