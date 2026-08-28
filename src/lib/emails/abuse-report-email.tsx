/**
 * Abuse-report intake notification — server-only, rendered by email-service.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  detailRowClass,
  EmailLayout,
  headingClass,
  paragraphClass,
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
      <Heading as="h2" className={headingClass}>
        New content report
      </Heading>
      <Text className={paragraphClass}>
        A report landed in the moderation queue. Open Admin → Moderation to
        triage it.
      </Text>

      <Section className="my-6 rounded-lg bg-muted p-6">
        <Text className={detailRowClass}>
          <strong>Reference:</strong> {reference}
        </Text>
        <Text className={detailRowClass}>
          <strong>Reason:</strong> {reason}
        </Text>
        <Text className={detailRowClass}>
          <strong>Target:</strong> {targetType}
        </Text>
        <Text className={detailRowClass}>
          <strong>Trace id supplied:</strong> {hasTrace ? 'yes' : 'no'}
        </Text>
      </Section>
    </Section>
  </EmailLayout>
);
