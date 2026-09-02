import { createFileRoute } from '@tanstack/react-router';
import { isPreviewDeployment } from '@/shared/utils/environment';
import { SITE_CONFIG } from '@/shared/marketing/constants';

function buildRobotsTxt(isPreview: boolean): string {
  if (isPreview) {
    return `User-agent: *\nDisallow: /\n`;
  }
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_CONFIG.url}/sitemap.xml\n`;
}

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const isPreview = isPreviewDeployment(request);
        return new Response(buildRobotsTxt(isPreview), {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      },
    },
  },
});
