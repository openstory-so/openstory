/**
 * Jobs table schema
 * Tracks async job execution via Temporal workflows
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teams } from "./teams";
import { users } from "./users";
import { jobStatusEnum, jobTypeEnum } from "./enums";

/**
 * Jobs table
 * Tracks async tasks (image generation, video generation, script analysis)
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: jobTypeEnum("type").notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    payload: jsonb("payload").default({}).notNull(),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Temporal workflow fields
    workflowId: text("workflow_id"), // Temporal workflow ID
    runId: text("run_id"), // Temporal run ID
  },
  (table) => ({
    teamIdIdx: index("idx_jobs_team_id").on(table.teamId),
    userIdIdx: index("idx_jobs_user_id").on(table.userId),
    statusIdx: index("idx_jobs_status").on(table.status),
    typeIdx: index("idx_jobs_type").on(table.type),
    createdAtIdx: index("idx_jobs_created_at").on(table.createdAt),
    workflowIdIdx: index("idx_jobs_workflow_id").on(table.workflowId),
  })
);

/**
 * Relations
 */
export const jobsRelations = relations(jobs, ({ one }) => ({
  team: one(teams, {
    fields: [jobs.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
}));

