/**
 * Authentication and authorization utilities
 * Centralized exports for auth functionality
 */

// BetterAuth configuration
export { auth, type Auth, type Session, type User } from "./config";

// RBAC utilities
export {
  TEAM_ROLES,
  type TeamRole,
  hasRole,
  getUserTeamRole,
  isTeamMember,
  requireTeamMember,
  requireTeamRole,
  requireTeamAdmin,
  requireTeamOwner,
  requireTeamMemberPlugin,
  requireTeamAdminPlugin,
  requireTeamOwnerPlugin,
} from "./rbac";

// Anonymous user migration
export {
  transferAnonymousUserData,
  type AnonymousMigrationResult,
} from "./anonymous-migration";

