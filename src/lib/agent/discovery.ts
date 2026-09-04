/**
 * Agent discovery support (#819).
 *
 * Two concerns, both applied in the Worker fetch wrapper (src/server.ts):
 *
 * 1. RFC 8288 `Link` response headers on document responses so agents can
 *    find our machine-readable resources (RFC 9727 §3 relation types).
 * 2. Markdown content negotiation: `Accept: text/markdown` returns a real
 *    markdown rendition where we have a markdown source (docs pages, FAQ,
 *    homepage overview). TanStack Start's router otherwise rejects non-HTML
 *    Accept headers with a 500, so paths without a markdown rendition get
 *    their Accept normalized to text/html instead.
 */
import { allDocs } from 'content-collections';
import { buildFaqMarkdown, buildLlmsTxt } from '@/shared/marketing/llms';

/**
 * RFC 8288 Link header advertising machine-readable discovery resources.
 * Relation types are IANA-registered (RFC 9727 §3): `describedby` (a resource
 * describing this one), `service-doc` (human-oriented service documentation),
 * and `service-desc` (a machine-readable service description — our OpenAPI
 * spec, so an agent landing on any page can find the public API).
 */
export const DISCOVERY_LINK_HEADER = [
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</docs/llms.md>; rel="service-doc"; type="text/markdown"',
  '</api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"',
].join(', ');

/** True for GET/HEAD requests whose Accept header asks for markdown. */
export function acceptsMarkdown(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.get('accept');
  return accept !== null && accept.includes('text/markdown');
}

/**
 * Markdown rendition for a pathname, or null when we have no markdown source
 * for it. Trailing slashes are tolerated.
 */
export function getMarkdownForPath(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (path === '/') return buildLlmsTxt();
  if (path === '/docs/faq') return buildFaqMarkdown();

  if (path.startsWith('/docs/')) {
    const slug = path.slice('/docs/'.length);
    const doc = allDocs.find((d) => d.slug === slug);
    if (doc) {
      return `# ${doc.title}\n\n> ${doc.description}\n\n${doc.body}`;
    }
  }

  return null;
}

/**
 * Builds the text/markdown response. `x-markdown-tokens` is a rough estimate
 * (~4 chars/token) mirroring Cloudflare's Markdown for Agents header so
 * agents can budget context before fetching.
 */
export function markdownResponse(markdown: string, method: string): Response {
  const headers = new Headers({
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Markdown-Tokens': String(Math.ceil(markdown.length / 4)),
    Vary: 'Accept',
    Link: DISCOVERY_LINK_HEADER,
  });
  return new Response(method === 'HEAD' ? null : markdown, {
    status: 200,
    headers,
  });
}

/**
 * Clone of `request` with Accept normalized to text/html. Used when an agent
 * asks for markdown on a path that has no markdown rendition: per RFC 9110 a
 * server MAY ignore Accept, and HTML beats the router's 500 JSON error.
 */
export function withHtmlAccept(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('accept', 'text/html');
  return new Request(request, { headers });
}

/**
 * Adds the discovery Link header to document responses (HTML pages and the
 * homepage redirect). Other responses (API JSON, assets) pass through
 * untouched.
 */
export function withDiscoveryLinkHeader(
  response: Response,
  pathname: string
): Response {
  const isDocument =
    pathname === '/' ||
    (response.headers.get('content-type')?.includes('text/html') ?? false);
  if (!isDocument || response.headers.has('link')) return response;

  const augmented = new Response(response.body, response);
  augmented.headers.set('Link', DISCOVERY_LINK_HEADER);
  return augmented;
}
