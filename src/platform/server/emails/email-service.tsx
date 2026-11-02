/**
 * Email Service
 * Handles sending transactional emails via Cloudflare Email Service.
 * Templates are React components in src/lib/emails/ rendered to
 * email-safe HTML (and a plain-text version) by render-email.ts.
 */

import { getEnv } from '#env';
import { IS_PRODUCTION_DEPLOYMENT } from '@/platform/flags';
import { env as workerEnv } from 'cloudflare:workers';
import { AbuseReportEmail } from './abuse-report-email';
import { FeedbackEmail } from './feedback-email';
import { OrganizationInvitationEmail } from './organization-invitation-email';
import { OtpEmail } from './otp-email';
import { renderEmail } from './render-email';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'services', 'email-service']);

function getSendEmailBinding(): SendEmail {
  // Reach for the binding via `cloudflare:workers` directly so the type
  // resolves to SendEmail. `#env` resolves to a process.env shim at typecheck
  // time (because tsgo doesn't apply the `workerd` import condition), which
  // would type bindings as `string`.
  const binding = workerEnv.SEND_EMAIL;
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- generated Env types the binding as always-present; guard against wrangler.jsonc drift
  if (!binding) {
    throw new Error(
      'Email binding "SEND_EMAIL" not found. Ensure send_email is configured in wrangler.jsonc'
    );
  }
  return binding;
}

/** Display name for email copy; domain senders pass it to their templates. */
export function getAppName(): string {
  return getEnv().VITE_APP_NAME || 'OpenStory';
}

function getEmailConfig(): {
  fromEmail: string;
  fromName: string;
} {
  const envEmail = getEnv().EMAIL_FROM;
  const appName = getAppName();

  if (envEmail) {
    return { fromEmail: envEmail, fromName: appName };
  }

  if (!IS_PRODUCTION_DEPLOYMENT) {
    // Local dev simulates sends (the binding has no `remote` flag in the
    // default wrangler.jsonc block), so the sender never reaches a real
    // mailbox — any placeholder address works.
    return { fromEmail: 'dev@localhost', fromName: appName };
  }

  throw new Error(
    'EMAIL_FROM environment variable is required in production. Must be an address on a domain onboarded in Cloudflare Email Service.'
  );
}

export interface SendEmailParams {
  to: string;
  subject: string;
  body: React.ReactElement;
  replyTo?: string;
}

/**
 * Render an email template and send it using Cloudflare Email Service.
 * Domain-specific senders (sequence ready, billing) live next to their
 * templates and call this; platform is the transport only.
 */
export async function sendEmail({
  to,
  subject,
  body,
  replyTo,
}: SendEmailParams): Promise<{ success: boolean; error?: string }> {
  try {
    const { fromEmail, fromName } = getEmailConfig();

    const { html, text } = await renderEmail(body);

    const result = await getSendEmailBinding().send({
      from: { name: fromName, email: fromEmail },
      to,
      subject,
      html,
      text,
      ...(replyTo ? { replyTo } : {}),
    });

    logger.info('Sent successfully:', { data: result.messageId });
    return { success: true };
  } catch (error) {
    logger.error('Failed to send:', { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send email',
    };
  }
}

/**
 * Send OTP email for passwordless sign-in
 */
export async function sendOtpEmail(
  email: string,
  otp: string
): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: email,
    subject: 'Your sign-in code',
    body: <OtpEmail appName={getAppName()} otp={otp} />,
  });
}

/** Invite to an organization (#813). The link is the invitation id. */
export async function sendOrganizationInvitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.to,
    subject: `Join ${params.organizationName}`,
    body: (
      <OrganizationInvitationEmail
        appName={getAppName()}
        organizationName={params.organizationName}
        inviterName={params.inviterName}
        acceptUrl={params.acceptUrl}
      />
    ),
  });
}

/** Queue watcher for `/report` intake. Lands on `ABUSE_REPORT_NOTIFY_EMAIL`. */
export async function sendAbuseReportNotifyEmail(params: {
  to: string;
  reference: string;
  reason: string;
  targetType: string;
  hasTrace: boolean;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.to,
    subject: `[${params.reason}] content report ${params.reference}`,
    body: (
      <AbuseReportEmail
        appName={getAppName()}
        reference={params.reference}
        reason={params.reason}
        targetType={params.targetType}
        hasTrace={params.hasTrace}
      />
    ),
  });
}

/** In-app Feedback sidebar dialog — lands on CONTACT_EMAIL. */
export async function sendFeedbackEmail(params: {
  to: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.to,
    subject: `Feedback from ${params.userEmail}`,
    body: (
      <FeedbackEmail
        appName={getAppName()}
        userName={params.userName}
        userEmail={params.userEmail}
        organizationId={params.organizationId}
        message={params.message}
      />
    ),
  });
}
