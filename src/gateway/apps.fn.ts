/**
 * Settings → Developer → Apps: the organization's registered gateway apps,
 * their margin, SKUs and earnings. Wrappers only; the logic is in
 * `src/gateway/server/register-app.ts` and `manage-app.ts`.
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import {
  registerGatewayApp,
  type GatewayAppSummary,
} from '@/gateway/server/register-app';
import {
  archiveGatewayAppSku,
  listGatewayAppDetails,
  saveGatewayAppSku,
  setGatewayAppMargin,
  type GatewayAppDetails,
} from '@/gateway/server/manage-app';
import {
  APP_SKU_KEY_PATTERN,
  MAX_APP_MARGIN_BPS,
  MAX_APP_SKU_PRICE_MICROS,
} from '@/gateway/apps';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

export type {
  GatewayAppDetails,
  GatewayAppSkuSummary,
} from '@/gateway/server/manage-app';

/** The organization's apps with their SKUs and earnings. */
export const listGatewayAppsFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .handler(async ({ context }): Promise<GatewayAppDetails[]> =>
    listGatewayAppDetails(context.scopedDb)
  );

const marginSchema = z.object({
  appId: ulidSchema,
  marginBps: z.number().int().min(0).max(MAX_APP_MARGIN_BPS),
});

/** Set an app's margin; a lower one also lowers what users accepted. */
export const setGatewayAppMarginFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(marginSchema))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    await setGatewayAppMargin(context.scopedDb, data.appId, data.marginBps);
    return { success: true };
  });

const skuKeySchema = z.string().trim().regex(APP_SKU_KEY_PATTERN);

const saveSkuSchema = z.object({
  appId: ulidSchema,
  key: skuKeySchema,
  name: z.string().trim().min(1).max(100),
  priceMicros: z.number().int().min(1).max(MAX_APP_SKU_PRICE_MICROS),
});

/** Declare or change one of an app's SKUs. */
export const saveGatewayAppSkuFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(saveSkuSchema))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    const { appId, ...sku } = data;
    await saveGatewayAppSku(context.scopedDb, appId, sku);
    return { success: true };
  });

/** Stop offering a SKU; offering it again needs each user's approval. */
export const archiveGatewayAppSkuFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.object({ appId: ulidSchema, key: skuKeySchema })))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    await archiveGatewayAppSku(context.scopedDb, data.appId, data.key);
    return { success: true };
  });

const redirectUriSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => URL.canParse(value), 'Each redirect URI must be a URL');

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(512).optional(),
  redirectUris: z.array(redirectUriSchema).max(10).optional(),
});

/** Register an app: link an OAuth client the user created, or create one. */
export const registerGatewayAppFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(registerSchema))
  .handler(async ({ data, context }): Promise<GatewayAppSummary> =>
    registerGatewayApp({
      scopedDb: context.scopedDb,
      headers: getRequestHeaders(),
      name: data.name,
      clientId: data.clientId,
      redirectUris: data.redirectUris,
    })
  );
