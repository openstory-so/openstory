/**
 * "Ask Tom for Credits" request (#1096) — sent to the founder when a user hits
 * the billing gate and asks for credits instead of buying. Server-only —
 * rendered by email-service.tsx.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowClass,
  EmailLayout,
  headingClass,
  paragraphClass,
} from './email-layout';

interface FounderCreditRequestEmailProps {
  appName: string;
  userName: string;
  userEmail: string;
  teamId: string;
  balanceDisplay: string;
  message?: string;
}

export const FounderCreditRequestEmail: React.FC<
  FounderCreditRequestEmailProps
> = ({ appName, userName, userEmail, teamId, balanceDisplay, message }) => (
  <EmailLayout appName={appName} preview={`${userEmail} is asking for credits`}>
    <Section>
      <Heading as="h2" className={headingClass}>
        Credit request
      </Heading>
      <Text className={paragraphClass}>
        A user asked the founder for credits on the billing gate. Reply to them
        directly, or send a gift code.
      </Text>

      <Section className="my-6 rounded-lg bg-muted p-6">
        <Text className={detailRowClass}>
          <strong>Name:</strong> {userName || '—'}
        </Text>
        <Text className={detailRowClass}>
          <strong>Email:</strong> {userEmail}
        </Text>
        <Text className={detailRowClass}>
          <strong>Team:</strong> {teamId}
        </Text>
        <Text className={detailRowClass}>
          <strong>Balance:</strong> {balanceDisplay}
        </Text>
      </Section>

      {message ? (
        <Section className="my-6 rounded-lg bg-muted p-6">
          <Text className={detailRowClass}>
            <strong>Message:</strong>
          </Text>
          <Text className={paragraphClass}>{message}</Text>
        </Section>
      ) : null}
    </Section>
  </EmailLayout>
);
