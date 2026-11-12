/**
 * Gateway apps and grants (docs/architecture/model-gateway.md § Apps and
 * user-pays). An app is an OAuth client an organization owns; a grant is a
 * user's monthly spend cap for one client on one organization. Neither has a
 * foreign key into the Better Auth tables, and nothing cascades.
 */

import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  GatewayAppSkuStatus,
  GatewayAppStatus,
  SkuPrices,
} from '@/gateway/apps';
import { generateId } from '@/platform/id';
import { organization } from './organization';

export const gatewayApps = snakeCase.table(
  'gateway_apps',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // The owner; PR 4 credits its earnings here.
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    oauthClientId: text().notNull(),
    name: text({ length: 100 }).notNull(),
    status: text({ length: 20 })
      .$type<GatewayAppStatus>()
      .default('active')
      .notNull(),
    createdByUserId: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    // Added on top of provider cost for a user-pays caller; at most MAX_APP_MARGIN_BPS.
    marginBps: integer().default(0).notNull(),
  },
  (table) => [
    uniqueIndex('uq_gateway_apps_oauth_client').on(table.oauthClientId),
    index('idx_gateway_apps_organization').on(table.organizationId),
  ]
);

export type GatewayApp = InferSelectModel<typeof gatewayApps>;

export const gatewayGrants = snakeCase.table(
  'gateway_grants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    oauthClientId: text().notNull(),
    userId: text().notNull(),
    // The payer.
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    monthlyCapMicros: integer().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    revokedAt: integer({ mode: 'timestamp' }),
    // The app's margin the user approved; a charge applies at most this.
    acceptedMarginBps: integer().default(0).notNull(),
    // Each SKU's price the user approved, by key; a charge above it is refused.
    acceptedSkuPrices: text({ mode: 'json' })
      .$type<SkuPrices>()
      .default(sql`'{}'`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_gateway_grants_client_user_organization').on(
      table.oauthClientId,
      table.userId,
      table.organizationId
    ),
    index('idx_gateway_grants_user').on(table.userId),
  ]
);

export type GatewayGrant = InferSelectModel<typeof gatewayGrants>;

export const gatewayAppSkus = snakeCase.table(
  'gateway_app_skus',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    appId: text()
      .notNull()
      .references(() => gatewayApps.id, { onDelete: 'restrict' }),
    key: text({ length: 64 }).notNull(),
    name: text({ length: 100 }).notNull(),
    priceMicros: integer().notNull(),
    status: text({ length: 20 })
      .$type<GatewayAppSkuStatus>()
      .default('active')
      .notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_gateway_app_skus_app_key').on(table.appId, table.key),
  ]
);

export type GatewayAppSku = InferSelectModel<typeof gatewayAppSkus>;
