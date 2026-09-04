/**
 * "Auto-reload is paused" — server-only, rendered by email-service.
 *
 * Deliberately does not print the Stripe decline code: it is issuer jargon
 * ("do_not_honor") that tells the customer nothing they can act on.
 */

import { Button, Heading, Section, Text } from '@react-email/components';
import { EmailLayout, headingStyle, paragraphStyle } from './email-layout';

export interface AutoTopUpFailedEmailProps {
  appName: string;
  billingUrl: string;
  balanceDisplay: string;
}

const updateButtonStyle: React.CSSProperties = {
  marginTop: 16,
  boxSizing: 'border-box',
  display: 'inline-block',
  borderRadius: 6,
  backgroundColor: '#fafafa',
  padding: '12px 24px',
  textAlign: 'center',
  fontSize: 16,
  fontWeight: 700,
  color: '#262626',
  textDecoration: 'none',
};

export const AutoTopUpFailedEmail: React.FC<AutoTopUpFailedEmailProps> = ({
  appName,
  billingUrl,
  balanceDisplay,
}) => (
  <EmailLayout
    appName={appName}
    preview="Auto-reload is paused — your card was declined"
    footerNote="Questions? Reply to this email."
  >
    <Section>
      <Heading as="h2" style={headingStyle}>
        Auto-reload is paused
      </Heading>
      <Text style={paragraphStyle}>
        Your card was declined, so we stopped charging it. Generation stops when
        your balance runs out — {balanceDisplay} left.
      </Text>
      <Text style={paragraphStyle}>
        Update your card and auto-reload starts again.
      </Text>
      <Button href={billingUrl} style={updateButtonStyle}>
        Update card
      </Button>
    </Section>
  </EmailLayout>
);
