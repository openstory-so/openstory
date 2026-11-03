/**
 * Member email lookups. Membership writes go through the Better Auth
 * organization plugin (#813).
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { member, user } from '@/platform/server/db/schema';

export function createOrganizationManagementMethods(
  db: Database,
  organizationId: string
) {
  /**
   * Billing contact = the team owner, not whichever member tripped the
   * debit — they may not be the one holding the card (#1499).
   */
  async function getOwnerEmail(): Promise<string | null> {
    const [row] = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(eq(member.organizationId, organizationId), eq(member.role, 'owner'))
      )
      .limit(1);
    return row?.email ?? null;
  }

  /**
   * Email for a team member, snapshotted onto workflow payloads at trigger
   * time (#1276). Null if they left the team or have no address.
   */
  async function getMemberEmail(memberUserId: string): Promise<string | null> {
    const [row] = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, memberUserId)
        )
      )
      .limit(1);
    return row?.email ?? null;
  }

  return { getOwnerEmail, getMemberEmail };
}
