import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Database enums
 * These match the PostgreSQL enums defined in Supabase migrations
 */

export const teamMemberRoleEnum = pgEnum("team_member_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const sequenceStatusEnum = pgEnum("sequence_status", [
  "draft",
  "processing",
  "completed",
  "failed",
  "archived",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "credit_purchase",
  "credit_usage",
  "credit_refund",
  "credit_adjustment",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "image",
  "video",
  "script",
  "frame_generation",
  "motion",
]);

export const falRequestStatusEnum = pgEnum("fal_request_status", [
  "pending",
  "completed",
  "failed",
]);

export const letzaiRequestStatusEnum = pgEnum("letzai_request_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

