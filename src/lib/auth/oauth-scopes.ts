/**
 * OAuth scopes OpenStory issues (#1456). Pure constants — safe to import from
 * client code (the consent page and Settings render the descriptions); the
 * server-side wiring lives in `oauth-provider.ts`.
 */

/** Scopes that gate the protected resources (advertised in resource metadata). */
export const OAUTH_API_SCOPES = [
  'sequences:read',
  'sequences:write',
  'generate',
  'credits:read',
] as const;
export type OAuthApiScope = (typeof OAUTH_API_SCOPES)[number];

/** OIDC identity scopes + refresh tokens + the API scopes above. */
export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  ...OAUTH_API_SCOPES,
] as const;

/** Plain-language copy for the consent page, keyed by scope. */
export const OAUTH_SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'See your name and avatar',
  email: 'See your email address',
  offline_access: 'Stay connected without asking you to sign in again',
  'sequences:read': 'View your sequences, scenes, and generated media',
  'sequences:write': 'Edit sequences and scenes, and start exports',
  generate: 'Start generations that spend your credits',
  'credits:read': 'See your credit balance',
};
