/** Which path a generation takes, decided once at the trigger and snapshotted on the payload (#2430). */

import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import {
  getGatewayModel,
  unholdableReason,
  type GatewayModel,
} from '@/gateway/server/catalog';
import { priceGatewayJob } from '@/gateway/server/price';
import { validatedBody } from '@/gateway/server/submit-job';
import { OpenStoryError, ValidationError } from '@/platform/errors';
import type { ApiKeyProvider } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { RateCardError } from '@modelschemas/rate-card/evaluator';

export type GatewayRoute =
  | { readonly via: 'openstory'; readonly model: GatewayModel }
  | { readonly via: 'direct'; readonly reason: string };

/** Routes a run carries, keyed by `gatewayRouteKey`; a model with no entry is direct. */
export type GatewayRoutes = Readonly<Record<string, GatewayRoute>>;

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
 * Own key -> direct; platform key and a holdable card -> openstory; else
 * direct with the reason. A null `body` (built only in the run) leaves the
 * body check to `gatewayCannotRun` at the call.
 */
export async function resolveGatewayRoute({
  scopedDb,
  provider,
  modelId,
  body,
}: {
  readonly scopedDb: {
    readonly apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
  };
  readonly provider: GatewayProvider;
  readonly modelId: string;
  readonly body: GatewayJobInput | null;
}): Promise<GatewayRoute> {
  const ownKey = OWN_KEY[provider];
  if (ownKey && (await scopedDb.apiKeys.hasUsableKey(ownKey))) {
    return { via: 'direct', reason: 'The organization has its own key' };
  }
  let model: GatewayModel;
  try {
    model = await getGatewayModel(provider, modelId);
  } catch (error) {
    // A refusal routes direct; an outage throws.
    if (error instanceof OpenStoryError && error.statusCode < 500) {
      return { via: 'direct', reason: error.message };
    }
    throw error;
  }
  const reason =
    unholdableReason(model.card) ?? (body && gatewayCannotRun(model, body));
  return reason ? { via: 'direct', reason } : { via: 'openstory', model };
}
