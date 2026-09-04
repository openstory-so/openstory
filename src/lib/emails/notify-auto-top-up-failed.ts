/**
 * Tell the customer their auto-reload was declined (#1499).
 *
 * Server-only, and reached through a dynamic `import()` from
 * `@/lib/db/scoped/billing` so the email service and its
 * `cloudflare:workers` bindings stay out of any browser chunk (#1253).
 *
 * The one-shot guarantee lives in the caller: `recordAutoTopUpFailure` only
 * calls this on the CAS transition `autoTopUpFailedAt: null → now`, so the
 * 2nd..20th skipped attempt send nothing.
 */

import { type Microdollars, microsToDisplayUsd } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { teamMembers } from '@/lib/db/schema/teams';
import { user } from '@/lib/db/schema/auth';
import { getLogger } from '@/lib/observability/logger';
import { captureProductEvent } from '@/lib/observability/product-events';
import { sendAutoTopUpFailedEmail } from '@/lib/services/email-service';
import { SITE_CONFIG } from '@/shared/marketing/constants';
import { and, asc, eq, inArray } from 'drizzle-orm';

const logger = getLogger(['openstory', 'emails', 'auto-top-up-failed']);

/**
 * Billing contact = the team owner, falling back to an admin. Not the user
 * whose generation happened to trip the debit — they may not be the one
 * holding the card.
 */
async function getBillingContactEmail(
  db: Database,
  teamId: string
): Promise<string | null> {
  const rows = await db
    .select({ email: user.email, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(user, eq(teamMembers.userId, user.id))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        inArray(teamMembers.role, ['owner', 'admin'])
      )
    )
    .orderBy(asc(teamMembers.joinedAt));

  return (
    rows.find((row) => row.role === 'owner')?.email ?? rows[0]?.email ?? null
  );
}

export async function notifyAutoTopUpFailed(opts: {
  db: Database;
  teamId: string;
  userId: string;
  balanceMicros: Microdollars;
}): Promise<void> {
  const to = await getBillingContactEmail(opts.db, opts.teamId);
  if (!to) {
    logger.warn('No billing contact for declined auto top-up', {
      teamId: opts.teamId,
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
    properties: { team_id: opts.teamId },
  });
}
