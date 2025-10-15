/**
 * Database schema exports
 * Centralized export of all Drizzle schema definitions
 */

export * from "./ai-requests";
// Enums
export * from "./enums";
export * from "./jobs";
export * from "./sequences";
export * from "./styles";
export * from "./teams";
// Tables
export * from "./users";

import { falRequests, letzaiRequests } from "./ai-requests";
import { jobs } from "./jobs";
import { frames, sequences } from "./sequences";
import { styles } from "./styles";
import { teamInvitations, teamMembers, teams } from "./teams";
// Re-export all tables for Drizzle migrations
import {
  betterAuthAccount,
  betterAuthSession,
  betterAuthUser,
  betterAuthVerification,
  users,
} from "./users";

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
