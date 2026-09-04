/**
 * OpenRouter OAuth Callback Handler
 * Server-only — completes the OAuth PKCE flow after redirect.
 */

import { getCookie } from '@tanstack/react-start/server';
import { exchangeCodeForKey } from '@/lib/byok/openrouter-oauth';
import {
  getOAuthCookieName,
  unsealOAuthState,
} from '@/lib/byok/openrouter-oauth-cookie';
import type { ScopedDb } from '@/lib/db/scoped';

/** The slice of ScopedDb this flow needs — keeps tests cast-free. */
type OAuthScopedDb = {
  apiKeys: Pick<ScopedDb['apiKeys'], 'saveKey' | 'listKeys'>;
};

/**
 * How recently an OAuth key must have been saved to count as the winning
 * half of a double-delivered callback (observed hits are ~2s apart).
 */
const DOUBLE_DELIVERY_WINDOW_MS = 2 * 60 * 1000;

type CompleteOAuthParams = {
  /** Team resolved from the authenticated session on the callback request. */
  teamId: string;
  /** Authorization code from OpenRouter's redirect. */
  code: string;
  /** CSRF `state` query param echoed back via the callback URL. */
  csrfState: string | null;
  /** Whether the request arrived over HTTPS (selects the cookie name). */
  secureCookies: boolean;
  /** Delay before re-checking for a concurrent winner (test override). */
  recheckDelayMs?: number;
};

/**
 * Complete the OpenRouter OAuth PKCE flow.
 * Called by the callback route after OpenRouter redirects back.
 * Reads the encrypted PKCE state cookie set during initiation and verifies
 * it against the session team and the echoed CSRF state. Throws on failure;
 * the route clears the cookie on every outcome.
 */
export async function completeOpenRouterOAuth(
  {
    teamId,
    code,
    csrfState,
    secureCookies,
    recheckDelayMs = 3000,
  }: CompleteOAuthParams,
  scopedDb: OAuthScopedDb
): Promise<void> {
  const sealed = getCookie(getOAuthCookieName(secureCookies));
  const state = sealed ? await unsealOAuthState(sealed) : null;
  if (!state) {
    throw new Error('OAuth session expired or not found');
  }

  if (state.teamId !== teamId) {
    throw new Error('OAuth state does not match the active team');
  }

  if (!csrfState || state.csrfState !== csrfState) {
    throw new Error('OAuth state mismatch');
  }

  // Exchange code for API key
  let apiKey: string;
  try {
    ({ apiKey } = await exchangeCodeForKey(code, state.codeVerifier));
  } catch (error) {
    // OpenRouter's redirect occasionally delivers the callback twice (two
    // top-level navigations ~2s apart). The first request redeems the
    // single-use code and saves the key; this one then fails the exchange
    // with "Invalid code". If a fresh OAuth key exists, the flow actually
    // succeeded — don't overwrite the user's outcome with an error.
    if (await wasJustConnected(scopedDb)) return;
    // The hits can also run concurrently: the winner may still be mid-save
    // when this request's exchange fails (observed in the pr-825 tail).
    // One delayed re-check covers the winner's ~2s exchange+save.
    await new Promise((resolve) => setTimeout(resolve, recheckDelayMs));
    if (await wasJustConnected(scopedDb)) return;
    throw error;
  }

  // Save the key (encrypted)
  await scopedDb.apiKeys.saveKey({
    provider: 'openrouter',
    apiKey,
    source: 'oauth',
  });
}

/** True if a concurrent callback request already completed this flow. */
async function wasJustConnected(scopedDb: OAuthScopedDb): Promise<boolean> {
  const keys = await scopedDb.apiKeys.listKeys();
  return keys.some(
    (key) =>
      key.provider === 'openrouter' &&
      key.source === 'oauth' &&
      !key.isInvalid &&
      Date.now() - key.createdAt.getTime() < DOUBLE_DELIVERY_WINDOW_MS
  );
}
