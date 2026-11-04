import { getAppName, sendEmail } from '@/platform/server/emails/email-service';
/**
 * "Ask Tom for Credits" request (#1096) — sent to the founder when a user hits
 * the billing gate and asks for credits instead of buying. Server-only —
 * rendered by email-service.tsx.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowStyle,
  EmailLayout,
  headingStyle,
  mutedBoxStyle,
  paragraphStyle,
} from '@/platform/server/emails/email-layout';

interface FounderCreditRequestEmailProps {
  appName: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  balanceDisplay: string;
  message?: string;
}

const FounderCreditRequestEmail: React.FC<FounderCreditRequestEmailProps> = ({
  appName,
  userName,
  userEmail,
  organizationId,
  balanceDisplay,
  message,
}) => (
  <EmailLayout appName={appName} preview={`${userEmail} is asking for credits`}>
    <Section>
      <Heading as="h2" style={headingStyle}>
        Credit request
      </Heading>
      <Text style={paragraphStyle}>
        A user asked the founder for credits on the billing gate. Reply to them
        directly, or send a gift code.
      </Text>

      <Section style={mutedBoxStyle}>
        <Text style={detailRowStyle}>
          <strong>Name:</strong> {userName || '—'}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Email:</strong> {userEmail}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Organization:</strong> {organizationId}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Balance:</strong> {balanceDisplay}
        </Text>
      </Section>

      {message ? (
        <Section style={mutedBoxStyle}>
          <Text style={detailRowStyle}>
            <strong>Message:</strong>
          </Text>
          <Text style={paragraphStyle}>{message}</Text>
        </Section>
      ) : null}
    </Section>
  </EmailLayout>
);

/**
 * Notify the founder that a user asked for credits from the billing gate
 * ("Ask Tom for Credits", #1096).
 */
export async function sendFounderCreditRequestEmail(params: {
  to: string;
  userName: string;
  userEmail: string;
  organizationId: string;
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
        organizationId={params.organizationId}
        balanceDisplay={params.balanceDisplay}
        message={params.message}
      />
    ),
  });
}
