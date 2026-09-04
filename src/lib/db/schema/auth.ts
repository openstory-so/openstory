import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const user = snakeCase.table('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: 'boolean' }).default(false).notNull(),
  image: text(),
  createdAt: integer({ mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer({ mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  accessCode: text(),
  status: text().default('pending'),
});

export const session = snakeCase.table(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    token: text().notNull().unique(),
    createdAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)]
);

export const account = snakeCase.table(
  'account',
  {
    id: text().primaryKey(),
    // Better Auth 1.7 keys accounts on (issuer, accountId). Required at write
    // time by the plugin; left nullable in SQL so we can `ALTER TABLE ADD
    // COLUMN` without rebuilding `account` (#612). Backfill existing rows
    // before tightening to NOT NULL.
    issuer: text(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: integer({
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer({
      mode: 'timestamp_ms',
    }),
    scope: text(),
    password: text(),
    createdAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('account_userId_idx').on(table.userId),
    uniqueIndex('account_issuer_accountId_uidx').on(
      table.issuer,
      table.accountId
    ),
  ]
);

export const verification = snakeCase.table(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    createdAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
);

export const passkey = snakeCase.table(
  'passkey',
  {
    id: text().primaryKey(),
    name: text(),
    publicKey: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text().notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: integer({ mode: 'boolean' }).notNull(),
    transports: text(),
    createdAt: integer({ mode: 'timestamp_ms' }),
    aaguid: text(),
  },
  (table) => [
    index('passkey_userId_idx').on(table.userId),
    index('passkey_credentialID_idx').on(table.credentialID),
  ]
);

/**
 * Better Auth `deviceAuthorization` plugin (#1219). Columns match the plugin
 * schema; 1.7 requires unique indexes on both lookup codes (dedupe before
 * applying the migration).
 */
export const deviceCode = snakeCase.table(
  'device_code',
  {
    id: text().primaryKey(),
    deviceCode: text().notNull(),
    userCode: text().notNull(),
    userId: text(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    status: text().notNull(),
    lastPolledAt: integer({ mode: 'timestamp_ms' }),
    pollingInterval: integer(),
    clientId: text(),
    scope: text(),
  },
  (table) => [
    uniqueIndex('device_code_deviceCode_uidx').on(table.deviceCode),
    uniqueIndex('device_code_userCode_uidx').on(table.userCode),
  ]
);

/**
 * API keys for the public HTTP API, owned by Better Auth's `@better-auth/api-key`
 * plugin. Field names (JS keys) must match the plugin's schema exactly — the
 * Drizzle adapter resolves columns by property name (the `snakeCase` builder
 * handles the SQL column casing). The plugin associates a key with its owner via
 * `referenceId` (the creating user's id), not a FK, so there is no cascade edge
 * into `user` — this stays a purely additive table.
 */
export const apikey = snakeCase.table(
  'apikey',
  {
    id: text().primaryKey(),
    name: text(),
    start: text(),
    prefix: text(),
    key: text().notNull(),
    referenceId: text().notNull(),
    configId: text().default('default').notNull(),
    refillInterval: integer(),
    refillAmount: integer(),
    lastRefillAt: integer({ mode: 'timestamp_ms' }),
    enabled: integer({ mode: 'boolean' }).default(true).notNull(),
    rateLimitEnabled: integer({ mode: 'boolean' }).default(true).notNull(),
    rateLimitTimeWindow: integer(),
    rateLimitMax: integer(),
    requestCount: integer().default(0).notNull(),
    remaining: integer(),
    lastRequest: integer({ mode: 'timestamp_ms' }),
    expiresAt: integer({ mode: 'timestamp_ms' }),
    createdAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    permissions: text(),
    metadata: text(),
  },
  (table) => [
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
    index('apikey_configId_idx').on(table.configId),
  ]
);

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server (#1456): `jwt()` + `@better-auth/mcp`
// (= `@better-auth/oauth-provider`). Ported from `bun auth:generate`; field
// names must match the plugins' schemas exactly. The generated FKs into
// `user` / `session` are deliberately NOT declared: a cascade edge into a
// long-lived parent is the #612 trap (see CLAUDE.md), and the api-key table
// takes the same stance. The plugins join by value, not by constraint.
// FKs *between* the OAuth tables are kept (cascade from `oauth_client`), so
// pruning a registered client takes its tokens and consents with it.
// ---------------------------------------------------------------------------

/** Signing keys for the `jwt` plugin (private key encrypted with the auth secret). */
export const jwks = snakeCase.table('jwks', {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer({ mode: 'timestamp_ms' }),
  alg: text(),
  crv: text(),
});

/** Registered OAuth clients — mostly self-registered (RFC 7591) MCP clients and forks. */
export const oauthClient = snakeCase.table(
  'oauth_client',
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: integer({ mode: 'boolean' }).default(false),
    skipConsent: integer({ mode: 'boolean' }),
    enableEndSession: integer({ mode: 'boolean' }),
    subjectType: text(),
    scopes: text({ mode: 'json' }),
    clientCredentialsScopes: text({ mode: 'json' }).default([]),
    userId: text(),
    createdAt: integer({ mode: 'timestamp_ms' }),
    updatedAt: integer({ mode: 'timestamp_ms' }),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text({ mode: 'json' }),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: text({ mode: 'json' }).notNull(),
    postLogoutRedirectUris: text({ mode: 'json' }),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: integer({ mode: 'boolean' }),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: text({ mode: 'json' }),
    responseTypes: text({ mode: 'json' }),
    requirePKCE: integer('require_pkce', { mode: 'boolean' }),
    dpopBoundAccessTokens: integer({ mode: 'boolean' }).default(false),
    referenceId: text(),
    metadata: text({ mode: 'json' }),
  },
  (table) => [index('oauthClient_userId_idx').on(table.userId)]
);

/** Protected resources tokens can be minted for (seeded from `oauth-provider.ts`). */
export const oauthResource = snakeCase.table('oauth_resource', {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text({ mode: 'json' }),
  customClaims: text({ mode: 'json' }),
  dpopBoundAccessTokensRequired: integer({ mode: 'boolean' }).default(false),
  disabled: integer({ mode: 'boolean' }).default(false),
  createdAt: integer({ mode: 'timestamp_ms' }),
  updatedAt: integer({ mode: 'timestamp_ms' }),
  policyVersion: integer().default(1),
  metadata: text({ mode: 'json' }),
});

export const oauthClientResource = snakeCase.table(
  'oauth_client_resource',
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text()
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: text({ mode: 'json' }),
    createdAt: integer({ mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(
      table.clientId,
      table.resourceId
    ),
    index('oauthClientResource_clientId_idx').on(table.clientId),
    index('oauthClientResource_resourceId_idx').on(table.resourceId),
  ]
);

export const oauthRefreshToken = snakeCase.table(
  'oauth_refresh_token',
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text(),
    userId: text().notNull(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text({ mode: 'json' }),
    requestedUserInfoClaims: text({ mode: 'json' }),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
    revoked: integer({ mode: 'timestamp_ms' }),
    rotatedAt: integer({ mode: 'timestamp_ms' }),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: integer({ mode: 'timestamp_ms' }),
    authTime: integer({ mode: 'timestamp_ms' }),
    confirmation: text({ mode: 'json' }),
    scopes: text({ mode: 'json' }).notNull(),
  },
  (table) => [
    index('oauthRefreshToken_clientId_idx').on(table.clientId),
    index('oauthRefreshToken_sessionId_idx').on(table.sessionId),
    index('oauthRefreshToken_userId_idx').on(table.userId),
    index('oauthRefreshToken_authorizationCodeId_idx').on(
      table.authorizationCodeId
    ),
  ]
);

export const oauthAccessToken = snakeCase.table(
  'oauth_access_token',
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text(),
    userId: text(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text({ mode: 'json' }),
    requestedUserInfoClaims: text({ mode: 'json' }),
    refreshId: text().references(() => oauthRefreshToken.id, {
      onDelete: 'cascade',
    }),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
    revoked: integer({ mode: 'timestamp_ms' }),
    confirmation: text({ mode: 'json' }),
    scopes: text({ mode: 'json' }).notNull(),
  },
  (table) => [
    index('oauthAccessToken_clientId_idx').on(table.clientId),
    index('oauthAccessToken_sessionId_idx').on(table.sessionId),
    index('oauthAccessToken_userId_idx').on(table.userId),
    index('oauthAccessToken_authorizationCodeId_idx').on(
      table.authorizationCodeId
    ),
    index('oauthAccessToken_refreshId_idx').on(table.refreshId),
  ]
);

/** A user's grant to a client, keyed by the team it bills to (`referenceId`). */
export const oauthConsent = snakeCase.table(
  'oauth_consent',
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text(),
    referenceId: text(),
    resources: text({ mode: 'json' }),
    requestedUserInfoClaims: text({ mode: 'json' }),
    scopes: text({ mode: 'json' }).notNull(),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('oauthConsent_clientId_idx').on(table.clientId),
    index('oauthConsent_userId_idx').on(table.userId),
  ]
);

/** Replay tombstones for `private_key_jwt` client assertions (`jti`). */
export const oauthClientAssertion = snakeCase.table('oauth_client_assertion', {
  id: text().primaryKey(),
  expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
});

// Type exports
export type User = InferSelectModel<typeof user>;
