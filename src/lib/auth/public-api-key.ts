/**
 * Public-API keys are branded `osk_` (OpenStory Key). Shared so the api-key
 * plugin, the OAuth bearer router, and key-minting never drift on the prefix.
 */

export const PUBLIC_API_KEY_PREFIX = 'osk_';

/**
 * Value the api-key plugin should look up, or `null` to skip.
 * Bearer JWTs (#1456) must not be hashed as keys.
 */
export function readPublicApiKeyFromHeaders(
  headers: Headers | { get: (name: string) => string | null | undefined }
): string | null {
  const authHeader = headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    return bearer.startsWith(PUBLIC_API_KEY_PREFIX) ? bearer : null;
  }
  return headers.get('x-api-key') ?? null;
}
