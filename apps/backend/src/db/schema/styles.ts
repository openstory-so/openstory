import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teams } from "./teams";
import { users } from "./users";

/**
 * Styles library table
 * Reusable Style Stack presets for consistent artistic vision
 */
export const styles = pgTable(
  "styles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    configJson: jsonb("config_json").default({}).notNull(),
    isPublic: boolean("is_public").default(false),
    previewUrl: text("preview_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => ({
    teamIdIdx: index("idx_styles_team_id").on(table.teamId),
    isPublicIdx: index("idx_styles_is_public").on(table.isPublic),
  })
);

/**
 * Relations
 */
export const stylesRelations = relations(styles, ({ one }) => ({
  team: one(teams, {
    fields: [styles.teamId],
    references: [teams.id],
  }),
  creator: one(users, {
    fields: [styles.createdBy],
    references: [users.id],
  }),
}));

/**
 * Type exports
 */
export type Style = typeof styles.$inferSelect;
export type NewStyle = typeof styles.$inferInsert;

