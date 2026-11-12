/**
 * `gateway_apps` and `gateway_app_skus` (docs/architecture/model-gateway.md §
 * Apps and user-pays, § Margin and SKUs). Registering links a client only
 * when the signed-in user created it (`oauth_client.user_id`). Lowering a
 * margin or a SKU price lowers what every grant of the app accepted.
 */

import {
  APP_SKU_KEY_PATTERN,
  MAX_APP_MARGIN_BPS,
  MAX_APP_SKU_PRICE_MICROS,
  type AppTermsView,
} from '@/gateway/apps';
import { ValidationError } from '@/platform/errors';
import type { Database } from '@/platform/server/db/client';
import {
  gatewayAppSkus,
  gatewayApps,
  gatewayGrants,
  oauthClient,
  organization,
  type GatewayApp,
  type GatewayAppSku,
} from '@/platform/server/db/schema';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { generateId } from '@/platform/id';

export type RegisterGatewayAppResult =
  | { ok: true; app: GatewayApp }
  | { ok: false; reason: 'taken' | 'not_owner' };

/** What the gateway needs to know about a client at submit. */
export type GatewayAppOfClient = Pick<
  GatewayApp,
  'id' | 'organizationId' | 'status' | 'marginBps'
>;

/** A SKU's JSON path in `accepted_sku_prices`; the key pattern keeps it literal. */
function skuJsonPath(key: string): string {
  if (!APP_SKU_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      'A SKU key is lowercase letters, digits, _ and -, up to 64'
    );
  }
  return `$."${key}"`;
}

/** An active app's terms by its client, whichever organization owns it; null when none. */
export async function readAppTermsByClient(
  db: Database,
  oauthClientId: string
): Promise<AppTermsView | null> {
  const [app] = await db
    .select({
      appId: gatewayApps.id,
      appName: gatewayApps.name,
      ownerOrganizationId: gatewayApps.organizationId,
      ownerOrganizationName: organization.name,
      marginBps: gatewayApps.marginBps,
    })
    .from(gatewayApps)
    .innerJoin(organization, eq(organization.id, gatewayApps.organizationId))
    .where(
      and(
        eq(gatewayApps.oauthClientId, oauthClientId),
        eq(gatewayApps.status, 'active')
      )
    )
    .limit(1);
  if (!app) return null;
  const skus = await db
    .select({
      key: gatewayAppSkus.key,
      name: gatewayAppSkus.name,
      priceMicros: gatewayAppSkus.priceMicros,
    })
    .from(gatewayAppSkus)
    .where(
      and(
        eq(gatewayAppSkus.appId, app.appId),
        eq(gatewayAppSkus.status, 'active')
      )
    )
    .orderBy(asc(gatewayAppSkus.key));
  return { ...app, skus };
}

function assertMarginBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_APP_MARGIN_BPS) {
    throw new ValidationError(
      `A margin is whole basis points from 0 to ${MAX_APP_MARGIN_BPS}`
    );
  }
}

function assertSkuPrice(priceMicros: number): void {
  if (
    !Number.isSafeInteger(priceMicros) ||
    priceMicros <= 0 ||
    priceMicros > MAX_APP_SKU_PRICE_MICROS
  ) {
    throw new ValidationError(
      `A SKU price is above zero and at most ${MAX_APP_SKU_PRICE_MICROS} microdollars`
    );
  }
}

export function createGatewayAppsMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  /** The client of one of this organization's apps, as a scalar subquery. */
  const clientOfOwnApp = (appId: string) =>
    sql`(select ${gatewayApps.oauthClientId} from ${gatewayApps} where ${gatewayApps.id} = ${appId} and ${gatewayApps.organizationId} = ${organizationId})`;

  const ownApp = (appId: string) =>
    and(
      eq(gatewayApps.id, appId),
      eq(gatewayApps.organizationId, organizationId)
    );

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
          marginBps: gatewayApps.marginBps,
        })
        .from(gatewayApps)
        .where(eq(gatewayApps.oauthClientId, oauthClientId))
        .limit(1);
      return row ?? null;
    },

    /** An active app's margin, owner and active SKUs by client; null when none. */
    getTermsByOAuthClient: (oauthClientId: string) =>
      readAppTermsByClient(db, oauthClientId),

    /** One active SKU of an app, by key; null when unknown or archived. */
    getActiveSku: async (
      appId: string,
      key: string
    ): Promise<Pick<GatewayAppSku, 'key' | 'name' | 'priceMicros'> | null> => {
      const [row] = await db
        .select({
          key: gatewayAppSkus.key,
          name: gatewayAppSkus.name,
          priceMicros: gatewayAppSkus.priceMicros,
        })
        .from(gatewayAppSkus)
        .where(
          and(
            eq(gatewayAppSkus.appId, appId),
            eq(gatewayAppSkus.key, key),
            eq(gatewayAppSkus.status, 'active')
          )
        )
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
              marginBps: sql<number>`0`.as('margin_bps'),
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

    /**
     * Set an app's margin. A lower margin also lowers every grant that
     * accepted more, so raising it again needs each user's approval.
     * False when the app is not this organization's.
     */
    setMargin: async (appId: string, marginBps: number): Promise<boolean> => {
      assertMarginBps(marginBps);
      const [updated] = await db.batch([
        db
          .update(gatewayApps)
          .set({ marginBps, updatedAt: new Date() })
          .where(ownApp(appId))
          .returning({ id: gatewayApps.id }),
        db
          .update(gatewayGrants)
          .set({ acceptedMarginBps: marginBps })
          .where(
            and(
              sql`${gatewayGrants.oauthClientId} = ${clientOfOwnApp(appId)}`,
              sql`${gatewayGrants.acceptedMarginBps} > ${marginBps}`
            )
          ),
      ]);
      return updated.length > 0;
    },

    /** Every SKU of this organization's apps, by app then key. */
    listSkus: async (appIds: string[]): Promise<GatewayAppSku[]> => {
      if (appIds.length === 0) return [];
      return db
        .select({
          id: gatewayAppSkus.id,
          appId: gatewayAppSkus.appId,
          key: gatewayAppSkus.key,
          name: gatewayAppSkus.name,
          priceMicros: gatewayAppSkus.priceMicros,
          status: gatewayAppSkus.status,
          createdAt: gatewayAppSkus.createdAt,
          updatedAt: gatewayAppSkus.updatedAt,
        })
        .from(gatewayAppSkus)
        .innerJoin(gatewayApps, eq(gatewayApps.id, gatewayAppSkus.appId))
        .where(
          and(
            eq(gatewayApps.organizationId, organizationId),
            inArray(gatewayAppSkus.appId, appIds)
          )
        )
        .orderBy(asc(gatewayAppSkus.appId), asc(gatewayAppSkus.key));
    },

    /**
     * Declare or change a SKU and make it active. A lower price also lowers
     * every grant that accepted more. Null when the app is not this organization's.
     */
    saveSku: async (
      appId: string,
      input: { key: string; name: string; priceMicros: number }
    ): Promise<GatewayAppSku | null> => {
      const path = skuJsonPath(input.key);
      assertSkuPrice(input.priceMicros);
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const [saved] = await db.batch([
        db
          .insert(gatewayAppSkus)
          .select(
            db
              .select({
                id: sql<string>`${generateId()}`.as('id'),
                appId: gatewayApps.id,
                key: sql<string>`${input.key}`.as('key'),
                name: sql<string>`${input.name}`.as('name'),
                priceMicros: sql<number>`${input.priceMicros}`.as(
                  'price_micros'
                ),
                status: sql<string>`'active'`.as('status'),
                createdAt: sql`${nowSeconds}`.as('created_at'),
                updatedAt: sql`${nowSeconds}`.as('updated_at'),
              })
              .from(gatewayApps)
              .where(ownApp(appId))
          )
          .onConflictDoUpdate({
            target: [gatewayAppSkus.appId, gatewayAppSkus.key],
            set: {
              name: input.name,
              priceMicros: input.priceMicros,
              status: 'active',
              updatedAt: now,
            },
          })
          .returning(),
        db
          .update(gatewayGrants)
          .set({
            acceptedSkuPrices: sql`json_set(${gatewayGrants.acceptedSkuPrices}, ${path}, ${input.priceMicros})`,
          })
          .where(
            and(
              sql`${gatewayGrants.oauthClientId} = ${clientOfOwnApp(appId)}`,
              sql`json_extract(${gatewayGrants.acceptedSkuPrices}, ${path}) > ${input.priceMicros}`
            )
          ),
      ]);
      return saved[0] ?? null;
    },

    /**
     * Stop offering a SKU. Every grant forgets its accepted price, so
     * offering it again needs each user's approval. False when not found.
     */
    archiveSku: async (appId: string, key: string): Promise<boolean> => {
      const path = skuJsonPath(key);
      const [archived] = await db.batch([
        db
          .update(gatewayAppSkus)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(
            and(
              eq(gatewayAppSkus.key, key),
              sql`${gatewayAppSkus.appId} = (select ${gatewayApps.id} from ${gatewayApps} where ${ownApp(appId)})`
            )
          )
          .returning({ id: gatewayAppSkus.id }),
        db
          .update(gatewayGrants)
          .set({
            acceptedSkuPrices: sql`json_remove(${gatewayGrants.acceptedSkuPrices}, ${path})`,
          })
          .where(
            and(
              sql`${gatewayGrants.oauthClientId} = ${clientOfOwnApp(appId)}`,
              sql`json_extract(${gatewayGrants.acceptedSkuPrices}, ${path}) is not null`
            )
          ),
      ]);
      return archived.length > 0;
    },
  };
}
