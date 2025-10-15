import { relations } from "drizzle-orm";
import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { falRequestStatusEnum, letzaiRequestStatusEnum } from "./enums";
import { teams } from "./teams";
import { users } from "./users";

/**
 * Fal.ai requests table
 * Tracks all Fal.ai API requests for usage monitoring and cost calculation
 */
export const falRequests = pgTable(
  "fal_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id"), // Reference to jobs table (if exists)
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    model: varchar("model", { length: 255 }).notNull(),
    requestPayload: jsonb("request_payload").default({}).notNull(),
    responseData: jsonb("response_data"),
    costCredits: decimal("cost_credits", { precision: 10, scale: 4 }).default(
      "0",
    ),
    latencyMs: integer("latency_ms"),
    status: falRequestStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    jobIdIdx: index("idx_fal_requests_job_id").on(table.jobId),
    teamIdIdx: index("idx_fal_requests_team_id").on(table.teamId),
    userIdIdx: index("idx_fal_requests_user_id").on(table.userId),
    modelIdx: index("idx_fal_requests_model").on(table.model),
    statusIdx: index("idx_fal_requests_status").on(table.status),
    createdAtIdx: index("idx_fal_requests_created_at").on(table.createdAt),
  }),
);

/**
 * LetzAI requests table
 * Tracks all LetzAI API requests for usage monitoring and cost calculation
 */
export const letzaiRequests = pgTable(
  "letzai_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: text("job_id"), // LetzAI job ID
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    requestPayload: jsonb("request_payload").notNull(),
    status: letzaiRequestStatusEnum("status").notNull().default("pending"),
    responseData: jsonb("response_data"),
    error: text("error"),
    costCredits: decimal("cost_credits", { precision: 10, scale: 4 }),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    teamIdIdx: index("idx_letzai_requests_team_id").on(table.teamId),
    userIdIdx: index("idx_letzai_requests_user_id").on(table.userId),
    statusIdx: index("idx_letzai_requests_status").on(table.status),
    jobIdIdx: index("idx_letzai_requests_job_id").on(table.jobId),
    createdAtIdx: index("idx_letzai_requests_created_at").on(table.createdAt),
    endpointIdx: index("idx_letzai_requests_endpoint").on(table.endpoint),
    teamStatusCreatedIdx: index("idx_letzai_requests_team_status_created").on(
      table.teamId,
      table.status,
      table.createdAt,
    ),
  }),
);

/**
 * Relations
 */
export const falRequestsRelations = relations(falRequests, ({ one }) => ({
  team: one(teams, {
    fields: [falRequests.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [falRequests.userId],
    references: [users.id],
  }),
}));

export const letzaiRequestsRelations = relations(letzaiRequests, ({ one }) => ({
  team: one(teams, {
    fields: [letzaiRequests.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [letzaiRequests.userId],
    references: [users.id],
  }),
}));

/**
 * Type exports
 */
export type FalRequest = typeof falRequests.$inferSelect;
export type NewFalRequest = typeof falRequests.$inferInsert;

export type LetzaiRequest = typeof letzaiRequests.$inferSelect;
export type NewLetzaiRequest = typeof letzaiRequests.$inferInsert;
