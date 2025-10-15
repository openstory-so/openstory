/**
 * Authentication and authorization utilities
 * Centralized exports for auth functionality
 */

// Anonymous user migration
export {
  type AnonymousMigrationResult,
  transferAnonymousUserData,
} from "./anonymous-migration";
// BetterAuth configuration
export { type Auth, auth, type Session, type User } from "./config";
// RBAC utilities
export {
  getUserTeamRole,
  hasRole,
  isTeamMember,
  requireTeamAdmin,
  requireTeamAdminPlugin,
  requireTeamMember,
  requireTeamMemberPlugin,
  requireTeamOwner,
  requireTeamOwnerPlugin,
  requireTeamRole,
  TEAM_ROLES,
  type TeamRole,
} from "./rbac";
