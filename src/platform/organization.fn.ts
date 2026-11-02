/**
 * Heal legacy `team_members` onto `member` before the organization UI reads it.
 */

import { createServerFn } from '@tanstack/react-start';

import { authMiddleware } from './middleware.fn';
import { resolveUserTeam } from '@/platform/server/db/scoped';

export const ensureOrganizationMembershipFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const membership = await resolveUserTeam(
      context.user.id,
      context.session.session.activeOrganizationId
    );
    if (!membership) {
      throw new Error('No organization found for user');
    }
    return {
      organizationId: membership.organizationId,
      role: membership.role,
      name: membership.teamName,
    };
  });
