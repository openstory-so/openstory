/**
 * Google OAuth availability. Server-only (#1445): it reads
 * `GOOGLE_CLIENT_SECRET`, so it lives in `src/lib`, not next to the
 * Request-shaped deployment helpers in `@/shared/utils/environment`.
 */

import { getEnv } from '#env';

/**
 * Is Google OAuth configured (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set)?
 * Single source of truth for Google sign-in availability: gates both the
 * better-auth socialProviders registration (src/lib/auth/config.ts) and the
 * login form's Google button (via getAuthOptionsFn). Environments
 * without the secrets — local dev by default, PR previews (whose hosts have
 * no registered OAuth redirect URIs, so the deploy workflow doesn't push
 * them) — simply don't offer Google.
 */
export function isGoogleAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
