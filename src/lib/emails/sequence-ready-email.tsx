/**
 * "Your video is ready" — server-only, rendered by email-service.
 */

import {
  Button,
  Heading,
  Img,
  Link,
  Section,
  Text,
} from '@react-email/components';
import { EmailLayout, headingStyle, paragraphStyle } from './email-layout';

export interface SequenceReadyEmailProps {
  appName: string;
  title: string;
  watchUrl: string;
  creditsUrl: string;
  posterUrl?: string;
  clipMeta?: string;
  balanceDisplay: string;
  typicalShortCostDisplay: string;
}

const posterStyle: React.CSSProperties = {
  marginBottom: 24,
  borderRadius: 8,
};

const watchButtonStyle: React.CSSProperties = {
  marginTop: 16,
  marginBottom: 16,
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

const creditsLinkStyle: React.CSSProperties = {
  color: '#fafafa',
  textDecoration: 'underline',
};

export const SequenceReadyEmail: React.FC<SequenceReadyEmailProps> = ({
  appName,
  title,
  watchUrl,
  creditsUrl,
  posterUrl,
  clipMeta,
  balanceDisplay,
  typicalShortCostDisplay,
}) => (
  <EmailLayout
    appName={appName}
    preview={`${title} is ready`}
    footerNote="Questions? Reply to this email."
  >
    <Section>
      <Heading as="h2" style={headingStyle}>
        {title} is ready
      </Heading>
      {posterUrl ? (
        <Img src={posterUrl} width="536" alt="" style={posterStyle} />
      ) : null}
      {clipMeta ? <Text style={paragraphStyle}>{clipMeta}</Text> : null}
      <Button href={watchUrl} style={watchButtonStyle}>
        Watch
      </Button>
      <Text style={paragraphStyle}>
        <Link href={creditsUrl} style={creditsLinkStyle}>
          {balanceDisplay} left · another short is about{' '}
          {typicalShortCostDisplay}
        </Link>
      </Text>
    </Section>
  </EmailLayout>
);
