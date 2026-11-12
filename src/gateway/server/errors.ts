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

/** An app charge needs a user who approved it: an `osk_` key or a session cannot charge. */
export class UserPaysOnlyError extends PublicApiError {
  constructor() {
    super(
      'App charges are user-pays only. Send the OAuth access token of a user who approved this app; an osk_ key cannot charge.',
      'USER_PAYS_ONLY',
      403
    );
  }
}

/** The OAuth client is not a registered app, so it has no SKUs to charge. */
export class AppNotRegisteredError extends PublicApiError {
  constructor() {
    super(
      'This OAuth client is not a registered app. Register it under Settings → Developer → Apps.',
      'APP_NOT_REGISTERED',
      403
    );
  }
}

/** The payer is the app's own organization, which an app never charges. */
export class OwnOrganizationChargeError extends PublicApiError {
  constructor() {
    super(
      'An app cannot charge its own organization.',
      'OWN_ORGANIZATION',
      403
    );
  }
}

/** No active SKU with that key on the caller's app. */
export class UnknownSkuError extends PublicApiError {
  constructor(sku: string) {
    super(`This app has no active SKU "${sku}".`, 'UNKNOWN_SKU', 404, { sku });
  }
}

/** The user never approved this SKU at its current price. */
export class SkuNotApprovedError extends PublicApiError {
  constructor(details: {
    sku: string;
    priceMicros: number;
    acceptedPriceMicros: number | null;
  }) {
    super(
      'The user has not approved this price. Send them through authorization again with prompt=consent, or ask them to accept the new terms under Settings → Developer → Authorized apps.',
      'SKU_NOT_APPROVED',
      403,
      details
    );
  }
}

/** A charge without an `Idempotency-Key`, or one reused for another charge. */
export class IdempotencyKeyError extends PublicApiError {
  constructor(code: 'IDEMPOTENCY_KEY_REQUIRED' | 'IDEMPOTENCY_CONFLICT') {
    super(
      code === 'IDEMPOTENCY_KEY_REQUIRED'
        ? 'Send an Idempotency-Key header so a retried charge is not charged twice.'
        : 'This Idempotency-Key was used for a different charge.',
      code,
      code === 'IDEMPOTENCY_KEY_REQUIRED' ? 400 : 409
    );
  }
}
