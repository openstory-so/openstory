/**
 * ArkType validation schemas for teams
 * Replaces Zod schemas from Next.js frontend
 */

import { type } from "arktype";

/**
 * Team role enum
 */
export const teamRoleSchema = type("'owner'|'admin'|'member'|'viewer'");

/**
 * Create team request
 */
export const createTeamSchema = type({
  name: "string",
  slug: "string",
});

export type CreateTeamInput = typeof createTeamSchema.infer;

/**
 * Update team request
 */
export const updateTeamSchema = type({
  "name?": "string",
  "slug?": "string",
});

export type UpdateTeamInput = typeof updateTeamSchema.infer;

/**
 * Add team member request
 */
export const addTeamMemberSchema = type({
  userId: "string",
  role: teamRoleSchema,
});

export type AddTeamMemberInput = typeof addTeamMemberSchema.infer;

/**
 * Update team member role request
 */
export const updateTeamMemberRoleSchema = type({
  role: teamRoleSchema,
});

export type UpdateTeamMemberRoleInput = typeof updateTeamMemberRoleSchema.infer;

/**
 * Create team invitation request
 */
export const createTeamInvitationSchema = type({
  email: "string.email",
  role: teamRoleSchema,
  "expiresAt?": "Date",
});

export type CreateTeamInvitationInput = typeof createTeamInvitationSchema.infer;

/**
 * Team response
 */
export const teamResponseSchema = type({
  id: "string",
  name: "string",
  slug: "string",
  createdAt: "Date",
  updatedAt: "Date",
});

export type TeamResponse = typeof teamResponseSchema.infer;

/**
 * Team member response
 */
export const teamMemberResponseSchema = type({
  id: "string",
  teamId: "string",
  userId: "string",
  role: teamRoleSchema,
  createdAt: "Date",
});

export type TeamMemberResponse = typeof teamMemberResponseSchema.infer;
