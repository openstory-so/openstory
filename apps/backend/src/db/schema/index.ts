/**
 * Database schema exports
 * Centralized export of all Drizzle schema definitions
 */

// Enums
export * from "./enums";

// Tables
export * from "./users";
export * from "./teams";
export * from "./sequences";
export * from "./styles";
export * from "./ai-requests";
export * from "./jobs";

// Re-export all tables for Drizzle migrations
import { users, betterAuthUser, betterAuthSession, betterAuthAccount, betterAuthVerification } from "./users";
import { teams, teamMembers, teamInvitations } from "./teams";
import { sequences, frames } from "./sequences";
import { styles } from "./styles";
import { falRequests, letzaiRequests } from "./ai-requests";
import { jobs } from "./jobs";

export const schema = {
  // Users & Auth
  users,
  betterAuthUser,
  betterAuthSession,
  betterAuthAccount,
  betterAuthVerification,

  // Teams
  teams,
  teamMembers,
  teamInvitations,

  // Sequences & Frames
  sequences,
  frames,

  // Styles
  styles,

  // AI Requests
  falRequests,
  letzaiRequests,

  // Jobs
  jobs,
};

