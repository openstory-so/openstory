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
import {
  boundedTerms,
  grantStanding,
  termsOfView,
  type AppTerms,
  type GrantStanding,
} from '@/gateway/apps';
import { readAppTermsByClient } from '@/gateway/server/db/gateway-apps';
import { monthlyCapMicrosSchema } from '@/platform/auth/oauth-spend-cap';
import { ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { gatewayGrants, member } from '@/platform/server/db/schema';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';

/** A live grant with what it has used this UTC month and the terms the user accepted. */
export type GatewayGrantStanding = GrantStanding & {
  oauthClientId: string;
  organizationId: string;
  accepted: AppTerms;
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

function acceptedOf(row: {
  acceptedMarginBps: number;
  acceptedSkuPrices: AppTerms['skuPrices'];
}): AppTerms {
  return {
    marginBps: row.acceptedMarginBps,
    skuPrices: row.acceptedSkuPrices,
  };
}

export function createGatewayGrantsMethods(db: Database, userId: string) {
  /** What approving `shown` records: bounded by what the app asks now. */
  const recordable = async (
    oauthClientId: string,
    shown: AppTerms
  ): Promise<AppTerms> =>
    boundedTerms(
      shown,
      termsOfView(await readAppTermsByClient(db, oauthClientId))
    );

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
          acceptedMarginBps: gatewayGrants.acceptedMarginBps,
          acceptedSkuPrices: gatewayGrants.acceptedSkuPrices,
        })
        .from(gatewayGrants)
        .where(liveGrantWhere(organizationId, oauthClientId, userId))
        .limit(1);
      if (!row) return null;
      return {
        oauthClientId,
        organizationId,
        accepted: acceptedOf(row),
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
          acceptedMarginBps: gatewayGrants.acceptedMarginBps,
          acceptedSkuPrices: gatewayGrants.acceptedSkuPrices,
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
        accepted: acceptedOf(row),
        ...grantStanding(
          row.monthlyCapMicros,
          Number(row.spentMicros),
          Number(row.heldMicros)
        ),
      }));
    },

    /**
     * Create or update the grant and make it live. With `shownTerms` (the
     * consent screen's), also records the terms the user approved, never
     * above what the app asks now; without, a new grant accepts nothing and
     * an existing one keeps its terms. Writes nothing unless the user is a
     * member of the organization; returns whether it wrote.
     */
    setCap: async (input: {
      oauthClientId: string;
      organizationId: string;
      monthlyCapMicros: number;
      shownTerms?: AppTerms;
    }): Promise<boolean> => {
      const cap = parseMonthlyCap(input.monthlyCapMicros);
      const terms = input.shownTerms
        ? await recordable(input.oauthClientId, input.shownTerms)
        : null;
      const termsJson = JSON.stringify(terms?.skuPrices ?? {});
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
              acceptedMarginBps: sql<number>`${terms?.marginBps ?? 0}`.as(
                'accepted_margin_bps'
              ),
              acceptedSkuPrices: sql`${termsJson}`.as('accepted_sku_prices'),
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
            ...(terms && {
              acceptedMarginBps: terms.marginBps,
              acceptedSkuPrices: terms.skuPrices,
            }),
          },
        })
        .returning({ id: gatewayGrants.id });
      return written.length > 0;
    },

    /**
     * Approve the app's current terms on a live grant, as Settings showed
     * them, never above what the app asks now. Returns whether it wrote.
     */
    acceptTerms: async (input: {
      oauthClientId: string;
      organizationId: string;
      shownTerms: AppTerms;
    }): Promise<boolean> => {
      const terms = await recordable(input.oauthClientId, input.shownTerms);
      const written = await db
        .update(gatewayGrants)
        .set({
          acceptedMarginBps: terms.marginBps,
          acceptedSkuPrices: terms.skuPrices,
          updatedAt: new Date(),
        })
        .where(
          and(
            liveGrantWhere(input.organizationId, input.oauthClientId, userId),
            exists(
              db
                .select({ id: member.id })
                .from(member)
                .where(isMember(input.organizationId))
            )
          )
        )
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
