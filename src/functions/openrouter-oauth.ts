/**
 * OpenRouter OAuth PKCE Server Functions
 *
 * Handles the initiation and completion of the OpenRouter OAuth PKCE flow.
 * Carries the temporary PKCE state between redirect hops in an encrypted
 * HttpOnly cookie (#807) — no server-side store.
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequest, setCookie } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { teamAdminAccessMiddleware } from './middleware';
import { buildAuthorizationUrl } from '@/lib/byok/openrouter-oauth';
import {
  getOAuthCookieName,
  getOAuthCookieOptions,
  sealOAuthState,
} from '@/lib/byok/openrouter-oauth-cookie';
import { getServerAppUrl } from '@/lib/utils/environment';

// ============================================================================
// Initiate OAuth Flow
// ============================================================================

const initiateOAuthInputSchema = z.object({
  teamId: z.string(),
});

/**
 * Start the OpenRouter OAuth PKCE flow.
 * Returns a URL to redirect the user to OpenRouter's auth page.
 */
export const initiateOpenRouterOAuthFn = createServerFn({ method: 'POST' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(initiateOAuthInputSchema))
  .handler(async ({ context }) => {
    const request = getRequest();
    const appUrl = getServerAppUrl(request);
    const callbackUrl = `${appUrl}/api/openrouter/callback`;

    const { url, state } = await buildAuthorizationUrl(
      callbackUrl,
      context.teamId,
      context.user.id
    );

    // Carry the PKCE state across the redirect in an encrypted HttpOnly
    // cookie; the callback reads, verifies, and clears it.
    const secure = appUrl.startsWith('https:');
    setCookie(
      getOAuthCookieName(secure),
      await sealOAuthState(state),
      getOAuthCookieOptions(secure)
    );

    return { authUrl: url };
  });
