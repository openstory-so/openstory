/**
 * Content report intake (#1180).
 *
 * Deliberately reachable **without a session**. The person whose likeness was
 * misused, or whose copyright was infringed, is precisely the person who does
 * not have an account here — a takedown channel that requires one is not a
 * takedown channel, and "we have a reporting mechanism" would not survive
 * contact with the first complaint.
 *
 * Consequences of being public, and what handles them:
 *
 *  - **No auth** ⇒ the handler trusts nothing in the payload. The target is
 *    stored as an opaque string and resolved later by a human; nothing here
 *    reads or mutates the reported content.
 *  - **Spam** ⇒ intake priority comes from the reason category, never from the
 *    reporter, so flooding the queue cannot bury a real report beneath fake
 *    ones. Request context is recorded for forensics.
 *  - **No enumeration** ⇒ the response is the same whether or not the target
 *    exists. A public endpoint that said "no such sequence" would be a free
 *    id-validity oracle.
 */

import {
  CONTENT_REPORT_REASONS,
  CONTENT_REPORT_TARGET_TYPES,
} from '@/lib/db/schema/compliance';
import { complianceEnv } from '@/lib/compliance/config';
import {
  formatReportReference,
  parseTraceId,
} from '@/lib/compliance/provenance';
import { submitPublicContentReport } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { sendAbuseReportNotifyEmail } from '@/lib/services/email-service';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const logger = getLogger(['openstory', 'compliance', 'reports']);

export const submitContentReportFn = createServerFn({ method: 'POST' })
  .validator(
    zodValidator(
      z.object({
        targetType: z.enum(CONTENT_REPORT_TARGET_TYPES),
        /** An id, a URL, or a trace id — whatever the reporter has. */
        targetId: z.string().min(1).max(1000),
        reason: z.enum(CONTENT_REPORT_REASONS),
        details: z.string().max(5000).optional(),
        /** Optional so anonymous reporters aren't forced to identify themselves. */
        reporterEmail: z.string().email().max(320).optional(),
        traceId: z.string().max(60).optional(),
      })
    )
  )
  .handler(async ({ data }) => {
    const request = getRequest();

    // A trace id may arrive in either field — reporters paste what we gave them
    // wherever the form seems to want it. Accept both.
    const traceId =
      (data.traceId ? parseTraceId(data.traceId) : null) ??
      parseTraceId(data.targetId);

    const report = await submitPublicContentReport({
      targetType: data.targetType,
      targetId: data.targetId.trim(),
      reason: data.reason,
      details: data.details?.trim() ?? null,
      traceId,
      reporterEmail: data.reporterEmail?.trim() ?? null,
      ipAddress: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    });

    // Logged at `warn` so a spike is visible in prod logs without paging, and
    // so the highest-severity categories are greppable. The report body is NOT
    // logged: it can contain a complainant's personal details, and logs are the
    // wrong retention regime for those.
    logger.warn('content report filed: {reason} on {targetType}', {
      reportId: report.id,
      reason: report.reason,
      targetType: data.targetType,
      hasTrace: Boolean(traceId),
    });

    const reference = formatReportReference(report.id);

    const notifyTo = complianceEnv('ABUSE_REPORT_NOTIFY_EMAIL');
    if (notifyTo) {
      const sent = await sendAbuseReportNotifyEmail({
        to: notifyTo,
        reference,
        reason: report.reason,
        targetType: data.targetType,
        hasTrace: Boolean(traceId),
      });
      if (!sent.success) {
        logger.error(
          'report {reference} filed but operator notification to {notifyTo} failed',
          { reference, notifyTo, reportId: report.id }
        );
      }
    }

    // The reference is what the reporter quotes when following up. Deliberately
    // returned even to anonymous reporters — a complaint you cannot chase is a
    // complaint you have to file again. Prefixed `OR-` so it cannot be parsed
    // as a provenance trace id (`OS-`).
    return { reference };
  });
