/**
 * One-time sign-in code email. Server-only — rendered by email-service.tsx.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  EmailLayout,
  headingStyle,
  mutedBoxStyle,
  paragraphStyle,
  WarningBox,
} from './email-layout';

interface OtpEmailProps {
  appName: string;
  otp: string;
}

const otpStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  textAlign: 'center',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 36,
  fontWeight: 700,
  letterSpacing: 8,
  color: '#fafafa',
};

export const OtpEmail: React.FC<OtpEmailProps> = ({ appName, otp }) => (
  <EmailLayout appName={appName} preview={`Your sign-in code is ${otp}`}>
    <Section>
      <Heading as="h2" style={headingStyle}>
        Your Sign-In Code
      </Heading>
      <Text style={paragraphStyle}>
        Enter this code to sign in to your account:
      </Text>

      <Section style={mutedBoxStyle}>
        <Text style={otpStyle}>{otp}</Text>
      </Section>

      <WarningBox title="This code expires in 5 minutes">
        If you didn't request this code, you can safely ignore this email.
      </WarningBox>
    </Section>
  </EmailLayout>
);
