import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sequenceStatusEnum } from "./enums";
import { styles } from "./styles";
import { teams } from "./teams";
import { users } from "./users";

/**
 * Sequences table
 * Video projects containing script and storyboard
 */
export const sequences = pgTable(
  "sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 500 }).notNull(),
    script: text("script"),
    status: sequenceStatusEnum("status").notNull().default("draft"),
    styleId: uuid("style_id").references(() => styles.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    teamIdIdx: index("idx_sequences_team_id").on(table.teamId),
    statusIdx: index("idx_sequences_status").on(table.status),
    createdAtIdx: index("idx_sequences_created_at").on(table.createdAt),
  }),
);

/**
 * Frames table
 * Individual shots within a sequence
 */
export const frames = pgTable(
  "frames",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    description: text("description"),
    durationMs: integer("duration_ms").default(3000),
    thumbnailUrl: text("thumbnail_url"),
    videoUrl: text("video_url"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sequenceIdIdx: index("idx_frames_sequence_id").on(table.sequenceId),
    orderIdx: index("idx_frames_order").on(table.sequenceId, table.orderIndex),
    uniqueOrder: unique("frames_sequence_id_order_index_key").on(
      table.sequenceId,
      table.orderIndex,
    ),
  }),
);

/**
 * Relations
 */
export const sequencesRelations = relations(sequences, ({ one, many }) => ({
  team: one(teams, {
    fields: [sequences.teamId],
    references: [teams.id],
  }),
  style: one(styles, {
    fields: [sequences.styleId],
    references: [styles.id],
  }),
  creator: one(users, {
    fields: [sequences.createdBy],
    references: [users.id],
  }),
  updater: one(users, {
    fields: [sequences.updatedBy],
    references: [users.id],
  }),
  frames: many(frames),
}));

export const framesRelations = relations(frames, ({ one }) => ({
  sequence: one(sequences, {
    fields: [frames.sequenceId],
    references: [sequences.id],
  }),
}));

/**
 * Type exports
 */
export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;

export type Frame = typeof frames.$inferSelect;
export type NewFrame = typeof frames.$inferInsert;
