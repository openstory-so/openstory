/**
 * Product analytics events that drive PostHog → Slack alerts (#1088, #1667).
 *
 * Prefer server-side capture so OAuth redirects, passkeys, and the public API
 * all emit the same events. Failures must never break the critical path.
 *
 * Person properties (email/name) must be set via `$set` / identify — event
 * properties alone leave `person.properties.*` empty, so Slack templates that
 * fall back to `event.distinct_id` only show the user id (#1110).
 */

import { getPostHogClient } from './posthog-server';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'observability', 'product-events']);

type ProductEventName =
  | 'user_signed_up'
  | 'user_signed_in'
  | 'sequence_generated'
  | 'sequence_error'
  | 'founder_credits_requested'
  | 'credits_added'
  | 'checkout_opened'
  | 'checkout_completed'
  | 'checkout_failed'
  | 'feedback_submitted'
  | 'sequence_ready_email_sent'
  | 'auto_top_up_failed_email_sent'
  | 'studio_generation_started'
  | 'studio_generation_completed'
  | 'sequence_content_ready'
  | 'welcome_card_setup_opened'
  | 'welcome_credits_granted';

export type CaptureProductEventArgs = {
  distinctId: string;
  event: ProductEventName;
  properties?: Record<string, unknown>;
  /**
   * Person properties attached to this distinctId. Sent as `$set` on the event
   * and via `identify` so PostHog People / Slack templates can read
   * `person.properties.email` (etc.) when the product event lands.
   */
  personProperties?: Record<string, unknown>;
};

/**
 * Fire-and-forget PostHog product event. Never throws.
 */
export function captureProductEvent(args: CaptureProductEventArgs): void {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;

    if (
      args.personProperties &&
      Object.keys(args.personProperties).length > 0
    ) {
      // Identify so the person profile is updated even if capture is filtered.
      posthog.identify({
        distinctId: args.distinctId,
        properties: args.personProperties,
      });
    }

    posthog.capture({
      distinctId: args.distinctId,
      event: args.event,
      properties: {
        ...args.properties,
        // Atomic with the event: destination templates that resolve
        // person.properties.* at ingest time see email/name immediately.
        ...(args.personProperties &&
        Object.keys(args.personProperties).length > 0
          ? { $set: args.personProperties }
          : {}),
      },
    });
  } catch (err) {
    logger.error('captureProductEvent failed', {
      event: args.event,
      distinctId: args.distinctId,
      err,
    });
  }
}
