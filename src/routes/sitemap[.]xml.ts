import { createFileRoute } from '@tanstack/react-router';
import { allDocs } from 'content-collections';
import { SITE_CONFIG } from '@/lib/marketing/constants';

// Static pages that serve a 200 to anonymous visitors. `/docs` is deliberately
// absent — it redirects to the first doc, and sitemap URLs must not 30x (#814).
// `/sequences/new` requires login (#1104), so it is not listed.
const SITEMAP_PAGES = [
  '/',
  '/login',
  '/sequences',
  '/images',
  '/videos',
  '/talent',
  '/locations',
  '/docs/faq',
  '/terms',
  '/privacy',
  '/report',
] as const;

function buildSitemap(): string {
  const paths = [
    ...SITEMAP_PAGES,
    ...allDocs.map((doc) => `/docs/${doc.slug}`),
  ];

  const urls = paths
    .map(
      (path) => `  <url>
    <loc>${SITE_CONFIG.url}${path}</loc>
  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        return new Response(buildSitemap(), {
          status: 200,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      },
    },
  },
});
