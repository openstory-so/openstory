/**
 * Settings → Developer → Apps: the organization's registered gateway apps.
 * Wrappers only; the logic is in `src/gateway/server/register-app.ts`.
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import {
  registerGatewayApp,
  toGatewayAppSummary,
  type GatewayAppSummary,
} from '@/gateway/server/register-app';

export type { GatewayAppSummary } from '@/gateway/server/register-app';

export const listGatewayAppsFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .handler(async ({ context }): Promise<GatewayAppSummary[]> =>
    (await context.scopedDb.gatewayApps.list()).map(toGatewayAppSummary)
  );

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
