import { pgTable, uuid, varchar, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teamMembers } from "./teams";

/**
 * Velro users table
 * Synced from BetterAuth "user" table via database trigger
 * Contains application-specific user data
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    fullName: varchar("full_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("idx_users_created_at").on(table.createdAt),
  })
);

/**
 * BetterAuth user table
 * Primary authentication table
 */
export const betterAuthUser = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
    // Anonymous plugin field
    isAnonymous: boolean("isAnonymous").default(false),
    // Additional fields
    fullName: text("fullName"),
    avatarUrl: text("avatarUrl"),
    onboardingCompleted: boolean("onboardingCompleted").default(false),
  },
  (table) => ({
    emailIdx: index("idx_user_email").on(table.email),
  })
);

/**
 * BetterAuth session table
 */
export const betterAuthSession = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: uuid("userId")
      .notNull()
      .references(() => betterAuthUser.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userIdIdx: index("idx_session_user_id").on(table.userId),
    tokenIdx: index("idx_session_token").on(table.token),
    expiresAtIdx: index("idx_session_expires_at").on(table.expiresAt),
  })
);

/**
 * BetterAuth account table
 * Links users to auth providers (OAuth, email/password, etc.)
 */
export const betterAuthAccount = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => betterAuthUser.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("idx_account_user_id").on(table.userId),
    providerIdx: index("idx_account_provider").on(table.providerId, table.accountId),
  })
);

/**
 * BetterAuth verification table
 * Email verification tokens
 */
export const betterAuthVerification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identifierIdx: index("idx_verification_identifier").on(table.identifier),
    expiresAtIdx: index("idx_verification_expires_at").on(table.expiresAt),
  })
);

/**
 * Relations
 */
export const usersRelations = relations(users, ({ many }) => ({
  teamMemberships: many(teamMembers),
}));

export const betterAuthUserRelations = relations(betterAuthUser, ({ many }) => ({
  sessions: many(betterAuthSession),
  accounts: many(betterAuthAccount),
}));

export const betterAuthSessionRelations = relations(betterAuthSession, ({ one }) => ({
  user: one(betterAuthUser, {
    fields: [betterAuthSession.userId],
    references: [betterAuthUser.id],
  }),
}));

export const betterAuthAccountRelations = relations(betterAuthAccount, ({ one }) => ({
  user: one(betterAuthUser, {
    fields: [betterAuthAccount.userId],
    references: [betterAuthUser.id],
  }),
}));

/**
 * Type exports
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type BetterAuthUser = typeof betterAuthUser.$inferSelect;
export type NewBetterAuthUser = typeof betterAuthUser.$inferInsert;

export type BetterAuthSession = typeof betterAuthSession.$inferSelect;
export type NewBetterAuthSession = typeof betterAuthSession.$inferInsert;

export type BetterAuthAccount = typeof betterAuthAccount.$inferSelect;
export type NewBetterAuthAccount = typeof betterAuthAccount.$inferInsert;

export type BetterAuthVerification = typeof betterAuthVerification.$inferSelect;
export type NewBetterAuthVerification = typeof betterAuthVerification.$inferInsert;

