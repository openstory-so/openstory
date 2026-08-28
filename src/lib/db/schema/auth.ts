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

// Type exports
export type User = InferSelectModel<typeof user>;
