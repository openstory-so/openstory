/**
 * In-app feedback (#1096) — server-only, rendered by email-service.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowClass,
  EmailLayout,
  headingClass,
  paragraphClass,
} from './email-layout';

interface FeedbackEmailProps {
  appName: string;
  userName: string;
  userEmail: string;
  teamId: string;
  message: string;
}

const messageClass =
  'm-0 whitespace-pre-wrap text-sm leading-6 text-foreground';

export const FeedbackEmail: React.FC<FeedbackEmailProps> = ({
  appName,
  userName,
  userEmail,
  teamId,
  message,
}) => (
  <EmailLayout appName={appName} preview={`Feedback from ${userEmail}`}>
    <Section>
      <Heading as="h2" className={headingClass}>
        Feedback
      </Heading>
      <Text className={paragraphClass}>
        A user sent feedback from the app sidebar.
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
      </Section>

      <Section className="my-6 rounded-lg border border-solid border-border p-6">
        <Text className={messageClass}>{message}</Text>
      </Section>
    </Section>
  </EmailLayout>
);
