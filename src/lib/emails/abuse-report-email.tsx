/**
 * Abuse-report intake notification — server-only, rendered by email-service.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowStyle,
  EmailLayout,
  headingStyle,
  mutedBoxStyle,
  paragraphStyle,
} from './email-layout';

interface AbuseReportEmailProps {
  appName: string;
  reference: string;
  reason: string;
  targetType: string;
  hasTrace: boolean;
}

export const AbuseReportEmail: React.FC<AbuseReportEmailProps> = ({
  appName,
  reference,
  reason,
  targetType,
  hasTrace,
}) => (
  <EmailLayout appName={appName} preview={`New ${reason} report ${reference}`}>
    <Section>
      <Heading as="h2" style={headingStyle}>
        New content report
      </Heading>
      <Text style={paragraphStyle}>
        A report landed in the moderation queue. Open Admin → Moderation to
        triage it.
      </Text>

      <Section style={mutedBoxStyle}>
        <Text style={detailRowStyle}>
          <strong>Reference:</strong> {reference}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Reason:</strong> {reason}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Target:</strong> {targetType}
        </Text>
        <Text style={detailRowStyle}>
          <strong>Trace id supplied:</strong> {hasTrace ? 'yes' : 'no'}
        </Text>
      </Section>
    </Section>
  </EmailLayout>
);
