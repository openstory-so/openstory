/**
 * Organization schema.
 * The tenant is `organization`. `member` and `invitation` are the Better Auth
 * organization plugin tables (#813). `team_members` stays until every
 * membership has been copied onto `member`.
 */

import { sql } from 'drizzle-orm';
import {
  integer,
  snakeCase,
  text,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';

// Enum values as constants (SQLite doesn't have native enums)
const TEAM_MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'expired',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * Teams table
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
  (table) => [uniqueIndex('idx_teams_slug').on(table.slug)]
);

/**
 * Team members junction table
 * Links users to an organization with roles
 */
export const teamMembers = snakeCase.table(
  'team_members',
  {
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text().$type<TeamMemberRole>().default('member').notNull(),
    joinedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index('idx_team_members_team_id').on(table.organizationId),
    index('idx_team_members_user_id').on(table.userId),
  ]
);

/**
 * Team invitations table
 * Manages pending, accepted, and declined team invitations
 */
export const teamInvitations = snakeCase.table(
  'team_invitations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text({ length: 255 }).notNull(),
    role: text().$type<TeamMemberRole>().default('member').notNull(),
    invitedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text().$type<InvitationStatus>().default('pending').notNull(),
    token: text({ length: 255 }).notNull(),
    // Default expiration: 7 days from now (handle in application code)
    expiresAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
      .notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    acceptedAt: integer({ mode: 'timestamp' }),
    declinedAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    index('idx_team_invitations_email').on(table.email),
    index('idx_team_invitations_expires_at').on(table.expiresAt),
    index('idx_team_invitations_status').on(table.status),
    index('idx_team_invitations_team_id').on(table.organizationId),
    uniqueIndex('idx_team_invitations_token').on(table.token),
    // Note: Partial unique index not supported in SQLite the same way
    // Enforce unique pending invitations in application logic or trigger
    index('idx_team_invitations_unique_pending').on(
      table.organizationId,
      table.email
    ),
  ]
);

/**
 * Better Auth `member`. One row per user per organization.
 * `created_at` is unix milliseconds, matching the other auth tables.
 * `team_members.joined_at` is seconds; the backfill multiplies by 1000.
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
    role: text().$type<TeamMemberRole>().default('member').notNull(),
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

/** Better Auth `invitation`. Replaces `team_invitations` for new invites. */
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
