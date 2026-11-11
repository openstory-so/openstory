/**
 * The gateway's user-pays refusals (docs/architecture/model-gateway.md §
 * Apps and user-pays). Each has its own code so an app can tell a cap from
 * an empty wallet.
 */

import type { GrantStanding } from '@/gateway/apps';
import { PublicApiError } from '@/platform/server/api-v1/errors';

/** The hold would take the client past the user's monthly cap. */
export class SpendCapExceededError extends PublicApiError {
  constructor(standing: GrantStanding, requestedMicros: number) {
    super(
      'This job would exceed the monthly spend cap the user set for this app. Ask them to raise it under Settings → Developer → Authorized apps, or wait for the next calendar month (UTC).',
      'SPEND_CAP_EXCEEDED',
      402,
      { ...standing, requestedMicros }
    );
  }
}

/** No live grant for (client, user, organization): never approved with a cap, or revoked. */
export class GrantRequiredError extends PublicApiError {
  constructor() {
    super(
      'This app has no spend cap for this organization, or the user revoked it. Send the user through authorization again so they can approve a monthly cap.',
      'GRANT_REQUIRED',
      403
    );
  }
}

/** The client is a registered app its owner or OpenStory suspended. */
export class AppSuspendedError extends PublicApiError {
  constructor() {
    super('This app is suspended.', 'APP_SUSPENDED', 403);
  }
}

/**
 * The client a user-pays caller spends under; null when the app pays. An
 * OAuth token that names no client is refused, never treated as app-pays.
 */
export function userPaysClientId(
  oauth: { clientId: string | null } | null
): string | null {
  if (!oauth) return null;
  if (!oauth.clientId) throw new GrantRequiredError();
  return oauth.clientId;
}
