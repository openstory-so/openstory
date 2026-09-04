/**
 * OpenRouter OAuth PKCE Service
 *
 * Implements the OAuth PKCE flow for OpenRouter so that:
 * - Users authorize OpenStory on OpenRouter's site
 * - OpenRouter issues a scoped, revocable API key
 * - OpenStory never sees the user's master OpenRouter credentials
 *
 * @see https://openrouter.ai/docs/use-cases/oauth-pkce
 */

import { z } from 'zod';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

/**
 * Generate a random URL-safe token (256 bits of entropy).
 * Used both as the PKCE code verifier and the CSRF state nonce.
 */
function generateUrlSafeToken(): string {
  const array = crypto.getRandomValues(new Uint8Array(32));
  return uint8ToUrlSafeBase64(array);
}

/**
 * Generate a PKCE code challenge from the verifier (S256 method).
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return uint8ToUrlSafeBase64(new Uint8Array(digest));
}

export type OAuthState = {
  teamId: string;
  userId: string;
  codeVerifier: string;
  /** CSRF nonce echoed back via the callback URL's `state` query param. */
  csrfState: string;
};

/**
 * Build the OpenRouter authorization URL for the PKCE flow.
 * The returned `state` must be carried across the redirect (encrypted
 * HttpOnly cookie — see openrouter-oauth-cookie.ts) so it can be verified
 * when OpenRouter redirects back.
 */
export async function buildAuthorizationUrl(
  callbackUrl: string,
  teamId: string,
  userId: string
): Promise<{ url: string; state: OAuthState }> {
  const codeVerifier = generateUrlSafeToken();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const csrfState = generateUrlSafeToken();

  // OpenRouter preserves query params already present on the callback_url,
  // so the CSRF state rides along and comes back on the redirect.
  const callbackWithState = new URL(callbackUrl);
  callbackWithState.searchParams.set('state', csrfState);

  const params = new URLSearchParams({
    callback_url: callbackWithState.toString(),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `${OPENROUTER_AUTH_URL}?${params.toString()}`,
    state: { teamId, userId, codeVerifier, csrfState },
  };
}

/**
 * Exchange an authorization code for an OpenRouter API key.
 * This is called after the user is redirected back from OpenRouter.
 */
export async function exchangeCodeForKey(
  code: string,
  codeVerifier: string
): Promise<{ apiKey: string }> {
  const response = await fetch(OPENROUTER_KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `OpenRouter key exchange failed (${response.status}): ${error}`
    );
  }

  const data = z.object({ key: z.string() }).parse(await response.json());

  return { apiKey: data.key };
}

// -- Helpers --

function uint8ToUrlSafeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error(`Byte at index ${i} is undefined`);
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
