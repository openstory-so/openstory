/**
 * The public web for the assistant (#2155): `web_search` (Brave Search, a
 * platform key) and `fetch_url` (one page as text). Both are reads with
 * `openWorldHint`: nothing of the team's leaves the Worker but the query or
 * the URL, and a result is text the model reads, never an instruction.
 */

import { z } from 'zod';
import { OpenStoryError } from '@/platform/errors';
import { optionalEnv } from '@/platform/server/env/environment';
import { openSafeUrl } from '@/platform/server/api-v1/safe-fetch';
import { openstoryTool } from '../tool-context';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const FETCH_TIMEOUT_MS = 10_000;
/** What one page hands the model; a longer page is cut, and says so. */
const PAGE_TEXT_MAX = 30_000;
/** Read at most this much of a body before cutting. */
const PAGE_BYTES_MAX = 2 * 1024 * 1024;

const braveResponseSchema = z.looseObject({
  web: z
    .looseObject({
      results: z.array(
        z.looseObject({
          title: z.string(),
          url: z.string(),
          description: z.string().optional(),
          age: z.string().optional(),
        })
      ),
    })
    .optional(),
});

const webSearch = openstoryTool({
  name: 'web_search',
  scope: 'sequences:read',
  annotations,
  description:
    'Search the public web and get titles, URLs and snippets. Use it for facts, references, prompting techniques or anything outside the team’s own work; follow up with fetch_url to read a page. Say which page a fact came from.',
  inputSchema: z.strictObject({
    query: z.string().trim().min(1).max(400),
    count: z.int().min(1).max(10).default(5),
  }),
  outputSchema: z.object({
    query: z.string(),
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        age: z.string().optional(),
      })
    ),
  }),
  run: async ({ query, count }) => {
    const key = optionalEnv('BRAVE_SEARCH_API_KEY');
    if (!key) {
      throw new OpenStoryError(
        'Web search is not set up on this server (no search key).',
        'WEB_SEARCH_UNAVAILABLE',
        400
      );
    }
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('text_decorations', 'false');
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new OpenStoryError(
        `Web search failed (${response.status}).`,
        'WEB_SEARCH_FAILED',
        400
      );
    }
    const body = braveResponseSchema.parse(await response.json());
    const results = (body.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? '',
      ...(r.age ? { age: r.age } : {}),
    }));
    return {
      data: { query, results },
      summary: `${results.length} results for ${JSON.stringify(query)}.`,
    };
  },
});

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML to readable text: scripts and styles dropped, tags to spaces, entities decoded. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const stripped = html
    .replace(/<(head|script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<\/(p|div|li|h[1-6]|tr|br|section|article)[^>]*>|<br[^>]*>/gi,
      '\n'
    )
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title: decodeEntities(title).replace(/\s+/g, ' ').trim(), text };
}

const fetchUrl = openstoryTool({
  name: 'fetch_url',
  scope: 'sequences:read',
  annotations,
  description:
    'Read one public web page (or a text or JSON document) as plain text, for a URL the user gave or web_search returned. Long pages are cut at 30,000 characters.',
  inputSchema: z.strictObject({
    url: z.url({ protocol: /^https?$/ }).max(2048),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    text: z.string(),
    truncated: z.boolean(),
  }),
  run: async ({ url }, { origin }) => {
    // The same SSRF-hardened opener the public API uses for element images:
    // host checks on every redirect hop, bounded hops, a connect budget. The
    // app's own origin is public but refused too, start and end, so a page
    // cannot be a way to call our API.
    const own = new URL(origin).origin;
    const refuseOwn = (candidate: string) => {
      if (new URL(candidate).origin === own) {
        throw new OpenStoryError(
          'Cannot fetch this app.',
          'FETCH_URL_REFUSED',
          400
        );
      }
    };
    refuseOwn(url);
    const response = await openSafeUrl(url, 'Page');
    if (response.url) refuseOwn(response.url);
    const type = response.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xhtml\+xml|xml))/i.test(type)) {
      throw new OpenStoryError(
        `Not a text page (${type.split(';')[0] || 'unknown type'}).`,
        'FETCH_URL_NOT_TEXT',
        400
      );
    }
    // Read a bounded prefix so a huge page never sits whole in memory, on
    // its own short clock: the opener's body budget is sized for a clip.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const bodyClock = setTimeout(() => void reader?.cancel(), FETCH_TIMEOUT_MS);
    try {
      while (reader) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        bytes += value.length;
        if (bytes >= PAGE_BYTES_MAX) {
          await reader.cancel();
          break;
        }
      }
    } finally {
      clearTimeout(bodyClock);
    }
    const raw = new TextDecoder().decode(concat(chunks, bytes));
    const { title, text } = /html/i.test(type)
      ? htmlToText(raw)
      : { title: '', text: raw.trim() };
    const truncated = text.length > PAGE_TEXT_MAX || bytes >= PAGE_BYTES_MAX;
    return {
      data: {
        url: response.url || url,
        title,
        text: text.slice(0, PAGE_TEXT_MAX),
        truncated,
      },
      summary: `${title || url}: ${Math.min(text.length, PAGE_TEXT_MAX)} characters${truncated ? ', cut' : ''}.`,
    };
  },
});

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, length - offset), offset);
    offset += chunk.length;
    if (offset >= length) break;
  }
  return out;
}

export const webTools = [webSearch, fetchUrl];
