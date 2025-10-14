/**
 * User Server Actions - BetterAuth Integration
 * Re-exports all user-related actions from better-auth implementation
 *
 * Note: Types must be imported directly from '@/app/actions/user/types'
 * This file does NOT have "use server" - it just re-exports from modules that do
 */

// Re-export all BetterAuth user actions (better-auth.ts has "use server")
export {
  checkUserTeamAccess,
  getCurrentUser,
  getUserTeam,
  getUserTeams,
} from "./better-auth";
