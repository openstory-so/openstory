import { ogFontLinks } from '@/ui/marketing/og-fonts';
import { createFileRoute } from '@tanstack/react-router';
import { OgImage } from '@/ui/marketing/og-image';

export const Route = createFileRoute('/meta/og')({
  head: () => ({ links: ogFontLinks }),
  component: OgImage,
});
