/**
 * Better Auth signs the raw consent query, including repeated `ba_param`
 * keys. TanStack's search parser keeps one value per key and rewrites the
 * address bar, so later reads of `location.search` fail signature verify.
 * Prefer the snapshot that still has `sig` and the most `ba_param` entries.
 */

export function scoreOAuthQuery(search: string): number {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search
  );
  return (
    (params.has('sig') ? 1000 : 0) +
    params.getAll('ba_param').length * 10 +
    search.length
  );
}

export function pickOAuthQuery(
  candidates: Array<string | null | undefined>
): string {
  let best = '';
  let bestScore = -1;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const score = scoreOAuthQuery(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function displayFieldsFromOAuthQuery(search: string): {
  clientId: string;
  scope: string;
  redirectUri: string | undefined;
} {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search
  );
  return {
    clientId: params.get('client_id') ?? '',
    scope: params.get('scope') ?? '',
    redirectUri: params.get('redirect_uri') ?? undefined,
  };
}
