/**
 * Invitation to join an organization. Server-only.
 */

import { Button, Heading, Section, Text } from '@react-email/components';
import {
  buttonStyle,
  EmailLayout,
  headingStyle,
  paragraphStyle,
} from './email-layout';

interface OrganizationInvitationEmailProps {
  appName: string;
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
}

export const OrganizationInvitationEmail: React.FC<
  OrganizationInvitationEmailProps
> = ({ appName, organizationName, inviterName, acceptUrl }) => (
  <EmailLayout
    appName={appName}
    preview={`${inviterName} invited you to ${organizationName}`}
  >
    <Section>
      <Heading as="h2" style={headingStyle}>
        Join {organizationName}
      </Heading>
      <Text style={paragraphStyle}>
        {inviterName} invited you to the {organizationName} organization on{' '}
        {appName}.
      </Text>
      <Button href={acceptUrl} style={buttonStyle}>
        Join organization
      </Button>
    </Section>
  </EmailLayout>
);
