/**
 * Email Service
 * Handles sending transactional emails via Cloudflare Email Service.
 * Templates are React components in src/lib/emails/ rendered to
 * email-safe HTML (and a plain-text version) by render-email.ts.
 */

import { getEnv } from '#env';
import { env as workerEnv } from 'cloudflare:workers';
import { AbuseReportEmail } from '@/lib/emails/abuse-report-email';
import { FeedbackEmail } from '@/lib/emails/feedback-email';
import { FounderCreditRequestEmail } from '@/lib/emails/founder-credit-request-email';
import { OtpEmail } from '@/lib/emails/otp-email';
import { SequenceReadyEmail } from '@/lib/emails/sequence-ready-email';
import { renderEmail } from '@/lib/emails/render-email';
import { CONTACT_EMAIL } from '@/lib/marketing/constants';
import { getLogger } from '@/lib/observability/logger';

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

function getAppName(): string {
  return getEnv().VITE_APP_NAME || 'OpenStory';
}

function getEmailConfig(): {
  fromEmail: string;
  fromName: string;
} {
  const env = getEnv();
  const envEmail = env.EMAIL_FROM;
  const isDev = env.NODE_ENV === 'development';
  const appName = getAppName();

  if (envEmail) {
    return { fromEmail: envEmail, fromName: appName };
  }

  if (isDev) {
    // Local dev simulates sends (the binding has no `remote` flag in the
    // default wrangler.jsonc block), so the sender never reaches a real
    // mailbox — any placeholder address works.
    return { fromEmail: 'dev@localhost', fromName: appName };
  }

  throw new Error(
    'EMAIL_FROM environment variable is required in production. Must be an address on a domain onboarded in Cloudflare Email Service.'
  );
}

interface SendEmailParams {
  to: string;
  subject: string;
  body: React.ReactElement;
  replyTo?: string;
}

/**
 * Render an email template and send it using Cloudflare Email Service
 */
async function sendEmail({
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

/**
 * Notify the founder that a user asked for credits from the billing gate
 * ("Ask Tom for Credits", #1096).
 */
export async function sendFounderCreditRequestEmail(params: {
  to: string;
  userName: string;
  userEmail: string;
  teamId: string;
  balanceDisplay: string;
  message?: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.to,
    subject: `Credit request from ${params.userEmail}`,
    body: (
      <FounderCreditRequestEmail
        appName={getAppName()}
        userName={params.userName}
        userEmail={params.userEmail}
        teamId={params.teamId}
        balanceDisplay={params.balanceDisplay}
        message={params.message}
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

/** "Your video is ready" — one per sequence, reply-to us (#1276). */
export async function sendSequenceReadyEmail(params: {
  to: string;
  title: string;
  watchUrl: string;
  creditsUrl: string;
  posterUrl?: string;
  clipMeta?: string;
  balanceDisplay: string;
  typicalShortCostDisplay: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.to,
    subject: `"${params.title}" is ready`,
    replyTo: CONTACT_EMAIL,
    body: (
      <SequenceReadyEmail
        appName={getAppName()}
        title={params.title}
        watchUrl={params.watchUrl}
        creditsUrl={params.creditsUrl}
        posterUrl={params.posterUrl}
        clipMeta={params.clipMeta}
        balanceDisplay={params.balanceDisplay}
        typicalShortCostDisplay={params.typicalShortCostDisplay}
      />
    ),
  });
}

/** In-app Feedback sidebar dialog — lands on CONTACT_EMAIL. */
export async function sendFeedbackEmail(params: {
  to: string;
  userName: string;
  userEmail: string;
  teamId: string;
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
        teamId={params.teamId}
        message={params.message}
      />
    ),
  });
}
