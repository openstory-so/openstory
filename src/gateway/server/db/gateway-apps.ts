/**
 * `gateway_apps` (docs/architecture/model-gateway.md § Apps and user-pays):
 * OAuth clients an organization registered as its apps. Registering links a
 * client only when the signed-in user created it (`oauth_client.user_id`).
 */

import type { Database } from '@/platform/server/db/client';
import {
  gatewayApps,
  oauthClient,
  type GatewayApp,
} from '@/platform/server/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { generateId } from '@/platform/id';

export type RegisterGatewayAppResult =
  | { ok: true; app: GatewayApp }
  | { ok: false; reason: 'taken' | 'not_owner' };

/** What the gateway needs to know about a client at submit. */
export type GatewayAppOfClient = Pick<
  GatewayApp,
  'id' | 'organizationId' | 'status'
>;

export function createGatewayAppsMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  return {
    /** This organization's apps, newest first. */
    list: async (): Promise<GatewayApp[]> =>
      db
        .select()
        .from(gatewayApps)
        .where(eq(gatewayApps.organizationId, organizationId))
        .orderBy(desc(gatewayApps.createdAt), desc(gatewayApps.id)),

    /**
     * The app a client is, whichever organization owns it; null when the
     * client is not a registered app. Read by the payer's submit.
     */
    getByOAuthClient: async (
      oauthClientId: string
    ): Promise<GatewayAppOfClient | null> => {
      const [row] = await db
        .select({
          id: gatewayApps.id,
          organizationId: gatewayApps.organizationId,
          status: gatewayApps.status,
        })
        .from(gatewayApps)
        .where(eq(gatewayApps.oauthClientId, oauthClientId))
        .limit(1);
      return row ?? null;
    },

    /**
     * Link a client the user created to this organization, in one guarded
     * insert: another user's client, or one already registered, writes nothing.
     */
    register: async (input: {
      oauthClientId: string;
      name: string;
    }): Promise<RegisterGatewayAppResult> => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const [created] = await db
        .insert(gatewayApps)
        .select(
          db
            .select({
              id: sql<string>`${generateId()}`.as('id'),
              organizationId: sql<string>`${organizationId}`.as(
                'organization_id'
              ),
              oauthClientId: oauthClient.clientId,
              name: sql<string>`${input.name}`.as('name'),
              status: sql<string>`'active'`.as('status'),
              createdByUserId: sql<string>`${userId}`.as('created_by_user_id'),
              createdAt: sql`${nowSeconds}`.as('created_at'),
              updatedAt: sql`${nowSeconds}`.as('updated_at'),
            })
            .from(oauthClient)
            .where(
              and(
                eq(oauthClient.clientId, input.oauthClientId),
                eq(oauthClient.userId, userId)
              )
            )
        )
        .onConflictDoNothing()
        .returning();
      if (created) return { ok: true, app: created };
      const [taken] = await db
        .select({ id: gatewayApps.id })
        .from(gatewayApps)
        .where(eq(gatewayApps.oauthClientId, input.oauthClientId))
        .limit(1);
      return { ok: false, reason: taken ? 'taken' : 'not_owner' };
    },
  };
}
