/**
 * OpenRouter OAuth state cookie
 *
 * Carries PKCE state across the OAuth redirect hops in an encrypted,
 * HttpOnly cookie instead of a server-side store (#807). The payload is
 * AES-256-GCM encrypted with API_KEY_ENCRYPTION_KEY, so the browser can
 * neither read nor forge it. The state is naturally per-browser-session,
 * which also fixes the old per-teamId key collision between two admins
 * running the flow concurrently.
 */

import { z } from 'zod';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key-encryption';
import type { OAuthState } from './openrouter-oauth';

/** How long the PKCE state stays valid between the redirect hops. */
export const OAUTH_STATE_TTL = 600; // seconds

const COOKIE_BASE_NAME = 'openrouter-oauth';

/**
 * `__Host-` pins the cookie to this origin (requires Secure + Path=/ and no
 * Domain). Plain-HTTP local dev falls back to the bare name since some
 * browsers (Safari) reject Secure cookies over http.
 */
export function getOAuthCookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_BASE_NAME}` : COOKIE_BASE_NAME;
}

export function getOAuthCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    // Lax so the cookie is sent on OpenRouter's top-level GET redirect back.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: OAUTH_STATE_TTL,
  };
}

/**
 * Serialized `Set-Cookie` header that clears the state cookie. The callback
 * route appends this manually to its redirect Response: headers prepared via
 * `deleteCookie()` are dropped by the framework when a handler returns a
 * non-2xx Response (such as a 302).
 */
export function getOAuthCookieClearHeader(secure: boolean): string {
  const name = getOAuthCookieName(secure);
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

const sealedPayloadSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  codeVerifier: z.string(),
  csrfState: z.string(),
  expiresAt: z.number(),
});

/**
 * Encrypt the OAuth state for transport in the cookie.
 * Reuses the AES-256-GCM module that protects stored API keys; the three
 * base64 parts (iv, ciphertext, tag) are joined with `.` (never in base64).
 */
export async function sealOAuthState(state: OAuthState): Promise<string> {
  const payload = JSON.stringify({
    ...state,
    expiresAt: Date.now() + OAUTH_STATE_TTL * 1000,
  });
  const { encryptedKey, keyIv, keyTag } = await encryptApiKey(payload);
  return [keyIv, encryptedKey, keyTag].join('.');
}

/**
 * Decrypt and validate a sealed OAuth state cookie value.
 * Returns null for anything tampered, malformed, or expired.
 */
export async function unsealOAuthState(
  sealed: string
): Promise<OAuthState | null> {
  const [keyIv, encryptedKey, keyTag] = sealed.split('.');
  if (!keyIv || !encryptedKey || !keyTag) return null;

  try {
    const plaintext = await decryptApiKey({ encryptedKey, keyIv, keyTag });
    const payload = sealedPayloadSchema.parse(JSON.parse(plaintext));
    if (payload.expiresAt < Date.now()) return null;

    return {
      teamId: payload.teamId,
      userId: payload.userId,
      codeVerifier: payload.codeVerifier,
      csrfState: payload.csrfState,
    };
  } catch {
    // Wrong key, tampered ciphertext, or malformed payload — treat all as absent.
    return null;
  }
}
