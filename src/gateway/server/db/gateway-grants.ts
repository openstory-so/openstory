/**
 * `gateway_grants` (docs/architecture/model-gateway.md § Apps and user-pays).
 * A grant is the signed-in user's: every method is bound to the user, takes
 * the payer organization explicitly, and writes only where the user is a
 * member of it.
 */

import {
  liveGrantWhere,
  liveHoldsSql,
  monthSpendSql,
  spendCapScope,
} from '@/billing/server/db/spend-cap';
import { grantStanding, type GrantStanding } from '@/gateway/apps';
import { monthlyCapMicrosSchema } from '@/platform/auth/oauth-spend-cap';
import { ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { gatewayGrants, member } from '@/platform/server/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

/** A live grant with what it has used this UTC month. */
export type GatewayGrantStanding = GrantStanding & {
  oauthClientId: string;
  organizationId: string;
};

/** A cap in microdollars, or a ValidationError naming the bounds. */
function parseMonthlyCap(value: unknown): number {
  const parsed = monthlyCapMicrosSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      'Set a monthly spend cap in whole dollars within the allowed range'
    );
  }
  return parsed.data;
}

export function createGatewayGrantsMethods(db: Database, userId: string) {
  const isMember = (organizationId: string) =>
    and(eq(member.userId, userId), eq(member.organizationId, organizationId));

  return {
    /** The live grant of (client, user, payer) and its standing now; null when none. */
    getStanding: async (
      oauthClientId: string,
      organizationId: string,
      now = new Date()
    ): Promise<GatewayGrantStanding | null> => {
      const scope = spendCapScope(organizationId, oauthClientId, now);
      const [row] = await db
        .select({
          monthlyCapMicros: gatewayGrants.monthlyCapMicros,
          spentMicros: monthSpendSql(scope),
          heldMicros: liveHoldsSql(scope),
        })
        .from(gatewayGrants)
        .where(liveGrantWhere(organizationId, oauthClientId, userId))
        .limit(1);
      if (!row) return null;
      return {
        oauthClientId,
        organizationId,
        ...grantStanding(
          row.monthlyCapMicros,
          Number(row.spentMicros),
          Number(row.heldMicros)
        ),
      };
    },

    /** Every live grant of the user in an organization they still belong to. */
    listStandings: async (
      now = new Date()
    ): Promise<GatewayGrantStanding[]> => {
      const scope = spendCapScope(
        gatewayGrants.organizationId,
        gatewayGrants.oauthClientId,
        now
      );
      const rows = await db
        .select({
          oauthClientId: gatewayGrants.oauthClientId,
          organizationId: gatewayGrants.organizationId,
          monthlyCapMicros: gatewayGrants.monthlyCapMicros,
          spentMicros: monthSpendSql(scope),
          heldMicros: liveHoldsSql(scope),
        })
        .from(gatewayGrants)
        .innerJoin(
          member,
          and(
            eq(member.organizationId, gatewayGrants.organizationId),
            eq(member.userId, gatewayGrants.userId)
          )
        )
        .where(
          and(eq(gatewayGrants.userId, userId), isNull(gatewayGrants.revokedAt))
        );
      return rows.map((row) => ({
        oauthClientId: row.oauthClientId,
        organizationId: row.organizationId,
        ...grantStanding(
          row.monthlyCapMicros,
          Number(row.spentMicros),
          Number(row.heldMicros)
        ),
      }));
    },

    /**
     * Create or update the grant and make it live. Writes nothing unless the
     * user is a member of the organization; returns whether it wrote.
     */
    setCap: async (input: {
      oauthClientId: string;
      organizationId: string;
      monthlyCapMicros: number;
    }): Promise<boolean> => {
      const cap = parseMonthlyCap(input.monthlyCapMicros);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const written = await db
        .insert(gatewayGrants)
        .select(
          db
            .select({
              id: sql<string>`${generateId()}`.as('id'),
              oauthClientId: sql<string>`${input.oauthClientId}`.as(
                'oauth_client_id'
              ),
              userId: sql<string>`${userId}`.as('user_id'),
              organizationId: sql<string>`${input.organizationId}`.as(
                'organization_id'
              ),
              monthlyCapMicros: sql<number>`${cap}`.as('monthly_cap_micros'),
              createdAt: sql`${nowSeconds}`.as('created_at'),
              updatedAt: sql`${nowSeconds}`.as('updated_at'),
              revokedAt: sql`null`.as('revoked_at'),
            })
            .from(member)
            .where(isMember(input.organizationId))
            .limit(1)
        )
        .onConflictDoUpdate({
          target: [
            gatewayGrants.oauthClientId,
            gatewayGrants.userId,
            gatewayGrants.organizationId,
          ],
          set: {
            monthlyCapMicros: cap,
            updatedAt: new Date(nowSeconds * 1000),
            revokedAt: null,
          },
        })
        .returning({ id: gatewayGrants.id });
      return written.length > 0;
    },

    /** Revoke the user's grants for a client: one organization's, or all of them. */
    revoke: async (input: {
      oauthClientId: string;
      organizationId: string | null;
    }): Promise<void> => {
      await db
        .update(gatewayGrants)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(gatewayGrants.oauthClientId, input.oauthClientId),
            eq(gatewayGrants.userId, userId),
            input.organizationId
              ? eq(gatewayGrants.organizationId, input.organizationId)
              : undefined,
            isNull(gatewayGrants.revokedAt)
          )
        );
    },
  };
}
