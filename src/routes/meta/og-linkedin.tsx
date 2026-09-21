import { ogFontLinks } from '@/ui/marketing/og-fonts';
import { createFileRoute } from '@tanstack/react-router';
import { OgImageLinkedIn } from '@/ui/marketing/og-image-linkedin';

export const Route = createFileRoute('/meta/og-linkedin')({
  head: () => ({ links: ogFontLinks }),
  component: OgImageLinkedIn,
});
