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
import { EmailLayout, headingClass, paragraphClass } from './email-layout';

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
      <Heading as="h2" className={headingClass}>
        {title} is ready
      </Heading>
      {posterUrl ? (
        <Img src={posterUrl} width="536" alt="" className="mb-6 rounded-lg" />
      ) : null}
      {clipMeta ? <Text className={paragraphClass}>{clipMeta}</Text> : null}
      <Button
        href={watchUrl}
        className="my-4 box-border inline-block rounded-md bg-primary px-6 py-3 text-center text-base font-bold text-primary-foreground no-underline"
      >
        Watch
      </Button>
      <Text className={paragraphClass}>
        <Link href={creditsUrl} className="text-foreground underline">
          {balanceDisplay} left · another short is about{' '}
          {typicalShortCostDisplay}
        </Link>
      </Text>
    </Section>
  </EmailLayout>
);
