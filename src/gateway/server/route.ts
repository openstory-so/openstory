/** Which path a generation takes, decided once at the trigger and snapshotted on the payload (#2430). */

import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import {
  getGatewayModel,
  unholdableReason,
  type GatewayModel,
} from '@/gateway/server/catalog';
import { priceGatewayJob } from '@/gateway/server/price';
import { OpenStoryError } from '@/platform/errors';
import type { ApiKeyProvider } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { RateCardError } from '@modelschemas/rate-card/evaluator';

export type GatewayRoute =
  | { readonly via: 'openstory'; readonly model: GatewayModel }
  | { readonly via: 'direct'; readonly reason: string };

/** The organization key that keeps a provider's calls on the direct path; BytePlus is platform-only. */
const OWN_KEY: Readonly<Record<GatewayProvider, ApiKeyProvider | null>> = {
  fal: 'fal',
  byteplus: null,
  gemini: 'google',
  grok: 'xai',
};

/** Own key -> direct; platform key and a card that can hold `body` -> openstory; else direct with the reason. */
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
  readonly body: GatewayJobInput;
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
  const unholdable = unholdableReason(model.card);
  if (unholdable) return { via: 'direct', reason: unholdable };
  try {
    priceGatewayJob(model.card, body);
  } catch (error) {
    if (error instanceof RateCardError) {
      return { via: 'direct', reason: error.message };
    }
    throw error;
  }
  return { via: 'openstory', model };
}
