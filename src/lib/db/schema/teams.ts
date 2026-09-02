/**
 * Teams Schema
 * Team management, members, and invitations
 */

import {
  integer,
  snakeCase,
  text,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
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
export const teams = snakeCase.table(
  'teams',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    name: text({ length: 255 }).notNull(),
    slug: text({ length: 255 }).notNull(),
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
 * Links users to teams with roles
 */
export const teamMembers = snakeCase.table(
  'team_members',
  {
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text().$type<TeamMemberRole>().default('member').notNull(),
    joinedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index('idx_team_members_team_id').on(table.teamId),
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
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
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
    index('idx_team_invitations_team_id').on(table.teamId),
    uniqueIndex('idx_team_invitations_token').on(table.token),
    // Note: Partial unique index not supported in SQLite the same way
    // Enforce unique pending invitations in application logic or trigger
    index('idx_team_invitations_unique_pending').on(table.teamId, table.email),
  ]
);
