/**
 * Organization schema.
 * The tenant is `organization`. `member` and `invitation` are the Better Auth
 * organization plugin tables (#813).
 */

import { sql } from 'drizzle-orm';
import {
  integer,
  snakeCase,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { deviceCode, user } from './auth';

// Enum values as constants (SQLite doesn't have native enums)
const ORGANIZATION_MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLES)[number];

/**
 * Organizations table
 * Core organization entity for collaboration
 */
export const organization = snakeCase.table(
  'organization',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    name: text({ length: 255 }).notNull(),
    slug: text({ length: 255 }).notNull(),
    logo: text(),
    metadata: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('idx_organization_slug').on(table.slug)]
);

/**
 * Better Auth `member`. One row per user per organization.
 * `created_at` is unix milliseconds, matching the other auth tables.
 */
export const member = snakeCase.table(
  'member',
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text().$type<OrganizationMemberRole>().default('member').notNull(),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
    uniqueIndex('member_organizationId_userId_uidx').on(
      table.organizationId,
      table.userId
    ),
  ]
);

/** Better Auth `invitation`. */
export const invitation = snakeCase.table(
  'invitation',
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    status: text().default('pending').notNull(),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    createdAt: integer({ mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    inviterId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ]
);

/**
 * The organization a device login was approved for. The plugin's
 * `device_code` row has no field for it; the key minted at exchange acts for
 * this one.
 */
export const deviceGrantOrganizations = snakeCase.table(
  'device_grant_organizations',
  {
    deviceCodeId: text()
      .primaryKey()
      .references(() => deviceCode.id, { onDelete: 'cascade' }),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
  }
);
