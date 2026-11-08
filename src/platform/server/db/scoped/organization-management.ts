/**
 * Member email lookups. Membership writes go through the Better Auth
 * organization plugin (#813).
 */

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { member, organization, user } from '@/platform/server/db/schema';

export function createOrganizationManagementMethods(
  db: Database,
  organizationId: string
) {
  /**
   * Billing contact = the organization owner, not whichever member tripped the
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
   * Email for an organization member, snapshotted onto workflow payloads at trigger
   * time (#1276). Null if they left the organization or have no address.
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

  /**
   * This organization, and whether it is the user's sign-up one: the first
   * organization they own (#2222). Null when the organization is gone.
   */
  async function getForUser(userId: string): Promise<{
    id: string;
    name: string;
    slug: string;
    personal: boolean;
  } | null> {
    const [current, [first]] = await Promise.all([
      db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1),
      db
        .select({ id: organization.id })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(and(eq(member.userId, userId), eq(member.role, 'owner')))
        .orderBy(asc(organization.createdAt), asc(organization.id))
        .limit(1),
    ]);
    const row = current[0];
    return row ? { ...row, personal: first?.id === row.id } : null;
  }

  return { getOwnerEmail, getMemberEmail, getForUser };
}
