import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teamMemberRoleEnum } from "./enums";
import { users } from "./users";
import { sequences } from "./sequences";
import { styles } from "./styles";

/**
 * Teams table
 * Core organizational unit - all resources belong to teams
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index("idx_teams_slug").on(table.slug),
  })
);

/**
 * Team members junction table
 * Links users to teams with roles
 */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamMemberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: {
      name: "team_members_pkey",
      columns: [table.teamId, table.userId],
    },
    userIdIdx: index("idx_team_members_user_id").on(table.userId),
    teamIdIdx: index("idx_team_members_team_id").on(table.teamId),
  })
);

/**
 * Team invitations table
 * Manages pending team member invitations
 */
export const teamInvitations = pgTable(
  "team_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: teamMemberRoleEnum("role").notNull().default("member"),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    token: varchar("token", { length: 255 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
  },
  (table) => ({
    teamIdIdx: index("idx_team_invitations_team_id").on(table.teamId),
    emailIdx: index("idx_team_invitations_email").on(table.email),
    tokenIdx: index("idx_team_invitations_token").on(table.token),
    statusIdx: index("idx_team_invitations_status").on(table.status),
    expiresAtIdx: index("idx_team_invitations_expires_at").on(table.expiresAt),
    uniquePendingIdx: uniqueIndex("idx_team_invitations_unique_pending").on(
      table.teamId,
      table.email
    ),
  })
);

/**
 * Relations
 */
export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  sequences: many(sequences),
  styles: many(styles),
  invitations: many(teamInvitations),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  team: one(teams, {
    fields: [teamInvitations.teamId],
    references: [teams.id],
  }),
  inviter: one(users, {
    fields: [teamInvitations.invitedBy],
    references: [users.id],
  }),
}));

/**
 * Type exports for use in application code
 */
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

export type TeamInvitation = typeof teamInvitations.$inferSelect;
export type NewTeamInvitation = typeof teamInvitations.$inferInsert;

