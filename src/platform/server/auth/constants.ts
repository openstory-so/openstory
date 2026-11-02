/**
 * Shared authentication constants.
 */

import type { TeamMemberRole } from '@/platform/server/db/schema/organization';

export type TeamRole = TeamMemberRole;

/**
 * Invitation token configuration
 */
export const INVITATION_CONFIG = {
  TOKEN_BYTES: 32,
  TOKEN_ENCODING: 'base64url' as const,
  EXPIRY_DAYS: 7,
} as const;
