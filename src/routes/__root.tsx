import { getEnv } from '#env';
import { getProductionDeploymentAppUrl } from '@/lib/utils/environment';
import { DocsReferrerTracker } from '@/components/docs/docs-referrer-tracker';
import { DefaultNotFound } from '@/components/error/default-not-found';
import { Providers } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import appCss from '@/styles/global.css?url';
import type { QueryClient } from '@tanstack/react-query';
import type { ErrorComponentProps } from '@tanstack/react-router';
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  redirect,
  Scripts,
  useRouter,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

type RouterContext = {
  queryClient: QueryClient;
};
const getIsPreviewFn = createIsomorphicFn()
  .server(() => {
    const appUrl = getEnv().VITE_APP_URL;
    if (!appUrl) return true;
    return appUrl.includes('pr-');
  })
  .client(() => false);

const getCanonicalOriginFn = createIsomorphicFn().server(() => {
  const request = getRequest();
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return null;

  // Don't redirect localhost or IP addresses (local/network dev access)
  const hostname = host.split(':')[0] ?? host;
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return null;
  }

  const canonical = new URL(getProductionDeploymentAppUrl(request));
  if (host === canonical.host) return null;
  return canonical.origin;
});

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ location }) => {
    // This is to redirect from git origins to the hash origin on preview branches
    const canonicalOrigin = getCanonicalOriginFn();
    if (canonicalOrigin) {
      throw redirect({ href: canonicalOrigin + location.href });
    }
  },
  head: () => {
    const isPreview = getIsPreviewFn();
    return {
      meta: [
        ...(isPreview
          ? [{ name: 'robots', content: 'noindex, nofollow' }]
          : []),
        { charSet: 'utf-8' },
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1',
        },
        { title: SITE_CONFIG.name },
        { name: 'description', content: SITE_CONFIG.description },
        // Open Graph
        { property: 'og:title', content: SITE_CONFIG.name },
        { property: 'og:description', content: SITE_CONFIG.description },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: SITE_CONFIG.url },
        { property: 'og:image', content: SITE_CONFIG.ogImage },
        { property: 'og:image:type', content: 'image/jpeg' },
        { property: 'og:image:width', content: '2400' },
        { property: 'og:image:height', content: '1260' },
        { property: 'og:site_name', content: SITE_CONFIG.name },
        // Twitter
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: SITE_CONFIG.name },
        { name: 'twitter:description', content: SITE_CONFIG.description },
        { name: 'twitter:image', content: SITE_CONFIG.ogImage },
        { name: 'twitter:url', content: SITE_CONFIG.url },
      ],
      scripts: [
        {
          type: 'application/ld+json',
          children: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: SITE_CONFIG.name,
            url: SITE_CONFIG.url,
            logo: `${SITE_CONFIG.url}/icon.svg`,
            sameAs: [SITE_CONFIG.githubHref],
          }),
        },
        {
          type: 'application/ld+json',
          children: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: SITE_CONFIG.name,
            url: SITE_CONFIG.url,
            description: SITE_CONFIG.description,
            publisher: {
              '@type': 'Organization',
              name: SITE_CONFIG.name,
            },
          }),
        },
      ],
      links: [
        { rel: 'stylesheet', href: appCss },
        { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' },
        {
          rel: 'icon',
          type: 'image/png',
          sizes: '32x32',
          href: '/icon-192.png',
        },
        {
          rel: 'apple-touch-icon',
          sizes: '180x180',
          href: '/apple-touch-icon.png',
        },
        { rel: 'manifest', href: '/manifest.json' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        {
          rel: 'preconnect',
          href: 'https://fonts.gstatic.com',
          crossOrigin: 'anonymous',
        },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Instrument+Serif:ital@0;1&display=swap',
        },
        {
          rel: 'stylesheet',
          href: 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap',
        },
      ],
    };
  },
  component: RootLayout,
  notFoundComponent: DefaultNotFound,
  errorComponent: ErrorBoundary,
});

function RootLayout() {
  const { queryClient } = Route.useRouteContext();
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers queryClient={queryClient}>
          <DocsReferrerTracker />
          <Outlet />
        </Providers>
        <Scripts />
      </body>
    </html>
  );
}

function ErrorBoundary({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">Something went wrong</h1>
      <p className="text-muted-foreground max-w-md text-center">
        {error instanceof Error
          ? error.message
          : 'An unexpected error occurred'}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
