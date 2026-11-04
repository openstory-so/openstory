/**
 * Tell the customer their auto-reload was declined (#1499). Once per
 * decline — `recordAutoTopUpFailure` owns that guarantee.
 */

import { type Microdollars, microsToDisplayUsd } from '@/billing/money';
import { getLogger } from '@/platform/logger';
import { captureProductEvent } from '@/platform/server/observability/product-events';
import { sendAutoTopUpFailedEmail } from './auto-top-up-failed-email';
import { SITE_CONFIG } from '@/ui/marketing/constants';

const logger = getLogger(['openstory', 'emails', 'auto-top-up-failed']);

export async function notifyAutoTopUpFailed(opts: {
  /** The organization owner's address (`scopedDb.organizationManagement.getOwnerEmail`); null = no owner row. */
  to: string | null;
  organizationId: string;
  userId: string;
  balanceMicros: Microdollars;
}): Promise<void> {
  const { to } = opts;
  if (!to) {
    logger.warn('No billing contact for declined auto top-up', {
      organizationId: opts.organizationId,
    });
    return;
  }

  const result = await sendAutoTopUpFailedEmail({
    to,
    billingUrl: `${SITE_CONFIG.url.replace(/\/$/, '')}/credits`,
    balanceDisplay: microsToDisplayUsd(opts.balanceMicros),
  });

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to send auto-top-up-failed email');
  }

  captureProductEvent({
    distinctId: opts.userId,
    event: 'auto_top_up_failed_email_sent',
    properties: {
      team_id: opts.organizationId,
      organization_id: opts.organizationId,
    },
  });
}
