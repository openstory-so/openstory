/** Which path a generation takes, decided once at the trigger and snapshotted on the payload (#2430). */

import {
  BYTEPLUS_ENDPOINTS,
  ELEVENLABS_ENDPOINTS,
  type GatewayJobInput,
  type GatewayProvider,
} from '@/gateway/schema';
import {
  getSnapshotGatewayModel,
  unholdableReason,
  type GatewayModel,
} from '@/gateway/server/catalog';
import { storedModelSchema } from '@/gateway/server/db/gateway-models';
import { priceGatewayJob } from '@/gateway/server/price';
import { GATEWAY_DRIVERS } from '@/gateway/server/providers';
import { remoteGatewayConfigured } from '@/gateway/server/remote-config';
import { validatedBody } from '@/gateway/server/submit-job';
import { ValidationError } from '@/platform/errors';
import type { ApiKeyProvider } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { RateCardError } from '@modelschemas/rate-card/evaluator';

export type GatewayRoute =
  | { readonly via: 'openstory'; readonly model: GatewayModel }
  // The hosted gateway over HTTP on `OPENSTORY_API_KEY`: it prices and refuses, so no card here (#2438).
  | { readonly via: 'remote'; readonly target: GatewayRouteTarget }
  | { readonly via: 'direct'; readonly reason: string };

/** A route that goes to the gateway, in-process or hosted. */
export type GatewayCallRoute = Exclude<GatewayRoute, { via: 'direct' }>;

/** A route as the payload carries it: the model as JSON text, since the card's type is too deep for a step's `Serializable`. */
type GatewayRouteSnapshot =
  | { readonly via: 'openstory'; readonly model: string }
  | { readonly via: 'remote' }
  | { readonly via: 'direct'; readonly reason: string };

/** Routes a run carries, keyed by `gatewayRouteKey`; any kind of model. */
export type GatewayRoutes = Readonly<Record<string, GatewayRouteSnapshot>>;

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
  elevenlabs: null,
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
 * -> openstory; no key on this server and an `OPENSTORY_API_KEY` -> remote;
 * else direct with the reason. Never reads modelschemas. A null `body` (built
 * only in the run) leaves the body check to `gatewayRunRoute`.
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
  if (!serverHasKey(provider, model)) {
    return (
      remoteRoute({ provider, modelId }) ?? {
        via: 'direct',
        reason: 'not configured on this server',
      }
    );
  }
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
          snapshotRoute(
            await resolveGatewayRoute({
              scopedDb,
              ...target,
              body: body ?? null,
            })
          ),
        ] as const
    )
  );
  return Object.fromEntries(entries);
}

/** Whether this server holds the provider's key; with no snapshot row, any of its endpoints counts, so a key here always wins. */
function serverHasKey(
  provider: GatewayProvider,
  model: GatewayModel | null
): boolean {
  const { configured } = GATEWAY_DRIVERS[provider];
  if (model) return configured(model.endpointId);
  const endpoints: readonly string[] =
    provider === 'byteplus'
      ? Object.values(BYTEPLUS_ENDPOINTS)
      : provider === 'elevenlabs'
        ? ELEVENLABS_ENDPOINTS
        : [''];
  return endpoints.some(configured);
}

/** What the hosted gateway cannot run for an install yet; the call stays direct and needs a key here. */
const NOT_REMOTE: Readonly<Partial<Record<GatewayProvider, string>>> = {
  elevenlabs:
    'ElevenLabs is not served to installs: saved voices are account-wide slots',
};

/** The remote route when this server has no key for the provider and holds an OpenStory key; null otherwise. */
function remoteRoute(target: GatewayRouteTarget): GatewayRoute | null {
  if (!remoteGatewayConfigured()) return null;
  const refused = NOT_REMOTE[target.provider];
  return refused
    ? { via: 'direct', reason: refused }
    : { via: 'remote', target };
}

function snapshotRoute(route: GatewayRoute): GatewayRouteSnapshot {
  if (route.via === 'openstory') {
    return { via: 'openstory', model: JSON.stringify(route.model) };
  }
  return route.via === 'remote' ? { via: 'remote' } : route;
}

// ponytail: cleared whole at 64 entries; there are tens of snapshot models, so it rarely fills.
const parsedModels = new Map<string, GatewayModel>();

/** A snapshotted model, parsed once per isolate: a quote checks every shape against it. */
function parsedModel(json: string): GatewayModel {
  const hit = parsedModels.get(json);
  if (hit) return hit;
  if (parsedModels.size >= 64) parsedModels.clear();
  const model = storedModelSchema.parse(JSON.parse(json));
  parsedModels.set(json, model);
  return model;
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
  // The hosted side checks the body and the price; a refusal there is the error.
  if (route.via === 'remote') return { via: 'remote', target };
  const model = parsedModel(route.model);
  const reason = gatewayCannotRun(model, body);
  return reason ? { via: 'direct', reason } : { via: 'openstory', model };
}
