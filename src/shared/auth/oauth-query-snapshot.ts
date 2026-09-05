/**
 * Better Auth signs the raw consent query, including repeated `ba_param`
 * keys. TanStack's search parser (qss) JSON-encodes those repeats as one
 * array value, which fails signature verify. Pack the raw query into a
 * single `q` param before the router sees it.
 */

const PACK_PREFIX = 'v1.';

/** React consent page — only ever loaded with a packed `q` param. */
export const OAUTH_CONSENT_PATH = '/oauth/consent';
/**
 * Server handoff (`src/routes/oauth/consent-start.ts`). Better Auth redirects
 * here with the signed query; we 302 to {@link OAUTH_CONSENT_PATH} with `q`.
 */
export const OAUTH_CONSENT_START_PATH = '/oauth/consent-start';

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

export function packOAuthQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `${PACK_PREFIX}${b64}`;
}

export function unpackOAuthQuery(packed: string): string | null {
  if (!packed.startsWith(PACK_PREFIX)) return null;
  try {
    let b64 = packed
      .slice(PACK_PREFIX.length)
      .replaceAll('-', '+')
      .replaceAll('_', '/');
    const pad = (4 - (b64.length % 4)) % 4;
    b64 += '='.repeat(pad);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const raw = new TextDecoder().decode(bytes);
    return raw ? `?${raw}` : '';
  } catch {
    return null;
  }
}

function searchWithoutQMark(search: string): string {
  return search.startsWith('?') ? search.slice(1) : search;
}

/** Packed `v1.` token from `?q=…`, a bare token, or null. */
function packedQParam(search: string): string | null {
  const raw = searchWithoutQMark(search);
  if (!raw) return null;
  if (raw.startsWith(PACK_PREFIX)) {
    const token = raw.split('&')[0] ?? raw;
    return unpackOAuthQuery(token) !== null ? token : null;
  }
  const packed = new URLSearchParams(raw).get('q');
  if (packed && unpackOAuthQuery(packed) !== null) return packed;
  return null;
}

export function needsOAuthQueryPack(search: string): boolean {
  if (packedQParam(search)) return false;
  const params = new URLSearchParams(searchWithoutQMark(search));
  return params.has('sig') || params.getAll('ba_param').length > 1;
}

function packedConsentPath(search: string): string {
  const packed = packedQParam(search) ?? packOAuthQuery(search);
  return `${OAUTH_CONSENT_PATH}?q=${encodeURIComponent(packed)}`;
}

/** Safe `/oauth/consent?…` for login `redirectTo` and in-app redirects. */
export function consentPageHref(search: string): string {
  if (packedQParam(search) || needsOAuthQueryPack(search)) {
    return packedConsentPath(search);
  }
  const raw = searchWithoutQMark(search);
  return raw ? `${OAUTH_CONSENT_PATH}?${raw}` : OAUTH_CONSENT_PATH;
}

/**
 * Location for `GET /oauth/consent-start`. Packs the raw signed query so
 * TanStack never sees repeated `ba_param`. `null` when there is nothing to
 * hand off (no `client_id`, no packed `q`).
 */
export function consentStartLocation(search: string): string | null {
  if (packedQParam(search)) return packedConsentPath(search);
  const params = new URLSearchParams(searchWithoutQMark(search));
  if (!params.get('client_id')) return null;
  return packedConsentPath(search);
}

/**
 * Unpack `q=v1.…` (or a bare token) back to the signed query Better Auth
 * expects. Unpacked / unsigned search is returned with a leading `?`.
 */
export function resolveOAuthQuery(search: string): string {
  if (!search) return '';
  const packed = packedQParam(search);
  if (packed) return unpackOAuthQuery(packed) ?? search;
  return search.startsWith('?') ? search : `?${search}`;
}

export function displayFieldsFromOAuthQuery(search: string): {
  clientId: string;
  scope: string;
  redirectUri: string | undefined;
} {
  const params = new URLSearchParams(searchWithoutQMark(search));
  return {
    clientId: params.get('client_id') ?? '',
    scope: params.get('scope') ?? '',
    redirectUri: params.get('redirect_uri') ?? undefined,
  };
}
