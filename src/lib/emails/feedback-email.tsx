/**
 * In-app feedback (#1096) — server-only, rendered by email-service.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowStyle,
  EmailLayout,
  headingStyle,
  mutedBoxStyle,
  paragraphStyle,
} from './email-layout';

interface FeedbackEmailProps {
  appName: string;
  userName: string;
  userEmail: string;
  teamId: string;
  message: string;
}

const messageStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  whiteSpace: 'pre-wrap',
  fontSize: 14,
  lineHeight: '24px',
  color: '#fafafa',
};

const messageBoxStyle: React.CSSProperties = {
  marginTop: 24,
  marginBottom: 24,
  borderRadius: 8,
  border: '1px solid #2e2e2e',
  padding: 24,
};

export const FeedbackEmail: React.FC<FeedbackEmailProps> = ({
  appName,
  userName,
  userEmail,
  teamId,
  message,
}) => (
  <EmailLayout appName={appName} preview={`Feedback from ${userEmail}`}>
    <Section>
      <Heading as="h2" style={headingStyle}>
        Feedback
      </Heading>
      <Text style={paragraphStyle}>
        A user sent feedback from the app sidebar.
      </Text>

      <Section style={mutedBoxStyle}>
        <Text style={detailRowStyle}>
          <strong>Name:</strong> {userName || '—'}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Email:</strong> {userEmail}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Team:</strong> {teamId}
        </Text>
      </Section>

      <Section style={messageBoxStyle}>
        <Text style={messageStyle}>{message}</Text>
      </Section>
    </Section>
  </EmailLayout>
);
