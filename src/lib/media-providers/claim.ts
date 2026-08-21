import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';

type Claimable<K> = {
  readonly id: string;
  claim(
    modelKey: K,
    scopedDb?: FalCredentialScopedDb
  ): Promise<ResolvedApiKey | undefined>;
};

/**
 * First claim wins. Fal sits last in the production registries and always
 * returns a key, so a miss here means the registry was empty or a test
 * double declined every model.
 */
export async function claimFrom<K, P extends Claimable<K>>(
  providers: readonly P[],
  modelKey: K,
  scopedDb?: FalCredentialScopedDb
): Promise<{ provider: P; key: ResolvedApiKey }> {
  for (const provider of providers) {
    const key = await provider.claim(modelKey, scopedDb);
    if (key) return { provider, key };
  }
  throw new Error(`No media provider claimed model "${String(modelKey)}"`);
}

export function providerById<P extends { readonly id: string }>(
  providers: readonly P[],
  id: string,
  kind: string
): P {
  const provider = providers.find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown ${kind} provider: ${id}`);
  }
  return provider;
}
