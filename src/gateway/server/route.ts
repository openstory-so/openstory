/** Which path a generation takes, decided once at the trigger and snapshotted on the payload (#2430). */

import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import {
  getSnapshotGatewayModel,
  unholdableReason,
  type GatewayModel,
} from '@/gateway/server/catalog';
import { priceGatewayJob } from '@/gateway/server/price';
import { validatedBody } from '@/gateway/server/submit-job';
import { ValidationError } from '@/platform/errors';
import type { ApiKeyProvider } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { RateCardError } from '@modelschemas/rate-card/evaluator';

export type GatewayRoute =
  | { readonly via: 'openstory'; readonly model: GatewayModel }
  | { readonly via: 'direct'; readonly reason: string };

/** Routes a run carries, keyed by `gatewayRouteKey`; any kind of model. */
export type GatewayRoutes = Readonly<Record<string, GatewayRoute>>;

/** A model a trigger routes. */
export type GatewayRouteTarget = {
  readonly provider: GatewayProvider;
  readonly modelId: string;
};

export function gatewayRouteKey(
  provider: GatewayProvider,
  modelId: string
): string {
  return `${provider}/${modelId}`;
}

/** The organization key that keeps a provider's calls on the direct path; BytePlus is platform-only. */
const OWN_KEY: Readonly<Record<GatewayProvider, ApiKeyProvider | null>> = {
  fal: 'fal',
  byteplus: null,
  gemini: 'google',
  grok: 'xai',
};

type RouteScopedDb = {
  readonly apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
};

/** Why the gateway cannot run this body on this model, or null: the schema and the card, no read. */
export function gatewayCannotRun(
  model: GatewayModel,
  body: GatewayJobInput
): string | null {
  try {
    priceGatewayJob(model.card, validatedBody(model, body));
    return null;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof RateCardError) {
      return error.message;
    }
    throw error;
  }
}

/**
 * Own key -> direct; platform key and a holdable card in the stored snapshot
 * -> openstory; else direct with the reason. Never reads modelschemas. A null
 * `body` (built only in the run) leaves the body check to `gatewayRunRoute`.
 */
export async function resolveGatewayRoute({
  scopedDb,
  provider,
  modelId,
  body,
}: GatewayRouteTarget & {
  readonly scopedDb: RouteScopedDb;
  readonly body: GatewayJobInput | null;
}): Promise<GatewayRoute> {
  const ownKey = OWN_KEY[provider];
  if (ownKey && (await scopedDb.apiKeys.hasUsableKey(ownKey))) {
    return { via: 'direct', reason: 'The organization has its own key' };
  }
  const model = await getSnapshotGatewayModel(provider, modelId);
  if (!model) return { via: 'direct', reason: 'not in the gateway snapshot' };
  const reason =
    unholdableReason(model.card) ?? (body && gatewayCannotRun(model, body));
  return reason ? { via: 'direct', reason } : { via: 'openstory', model };
}

/** The routes a trigger puts on the payload: one per model the run may call; `body` when the trigger already has it. */
export async function resolveGatewayRoutes(
  scopedDb: RouteScopedDb,
  targets: readonly (GatewayRouteTarget & {
    readonly body?: GatewayJobInput;
  })[]
): Promise<GatewayRoutes> {
  const entries = await Promise.all(
    targets.map(
      async ({ body, ...target }) =>
        [
          gatewayRouteKey(target.provider, target.modelId),
          await resolveGatewayRoute({
            scopedDb,
            ...target,
            body: body ?? null,
          }),
        ] as const
    )
  );
  return Object.fromEntries(entries);
}

/**
 * The route a run applies: its payload snapshot plus the pure body check, no
 * read, so a step retry takes the same route. Absent routes are a payload
 * from before #2434 and run direct.
 */
export function gatewayRunRoute(
  routes: GatewayRoutes | undefined,
  target: GatewayRouteTarget,
  body: GatewayJobInput
): GatewayRoute {
  if (!routes) return { via: 'direct', reason: 'triggered before routes' };
  const route = routes[gatewayRouteKey(target.provider, target.modelId)];
  if (!route) return { via: 'direct', reason: 'not routed at the trigger' };
  if (route.via === 'direct') return route;
  const reason = gatewayCannotRun(route.model, body);
  return reason ? { via: 'direct', reason } : route;
}
