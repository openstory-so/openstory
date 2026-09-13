/**
 * Rate-card source text for a fal endpoint (#1605): the llms.txt Pricing
 * section, its Input Schema section (what lets the extractor bind levers to
 * real param names), and — for token-priced models whose Pricing section
 * defers to "the description at the bottom of this page" — the size × quality
 * table only the playground HTML carries. `hash` covers the priced text
 * (Pricing + table), so a schema-only edit does not force a re-extraction.
 */
import { getLogger } from '@/platform/logger';
import { llmsTxtPricingSection } from './fal-pricing-fetch';

const logger = getLogger(['openstory', 'ai', 'rate-card-source']);

export type RateCardSource = {
  endpointId: string;
  /** The llms.txt URL — the card's `source.url`. */
  url: string;
  pricingSection: string;
  inputSchemaSection: string;
  /** Markdown `| Size | low | … |` table from the playground page, if any. */
  descriptionTable?: string;
  /** Pricing section + description table — the text the card is read from. */
  text: string;
  /** sha256 hex of `text`. */
  hash: string;
};

export type RateCardSourceResult =
  | { status: 'ok'; source: RateCardSource }
  /** The page exists but prices nothing — an honest absence, not a failure. */
  | { status: 'no-pricing' }
  | { status: 'failed' };

const llmsTxtUrl = (endpointId: string) =>
  `https://fal.ai/models/${endpointId}/llms.txt`;

/**
 * Body of the `### Input Schema` section: up to the next heading of the same
 * or a higher level, so `### Output Schema` and `## Usage Examples` both end it.
 */
export function llmsTxtInputSchemaSection(llmsTxt: string): string | null {
  const match = `${llmsTxt}\n## `.match(
    /^### Input Schema\s*\n([\s\S]*?)(?=\n###? )/m
  );
  return match?.[1]?.trim() || null;
}

/**
 * The `| Size | low | medium | … |` table the playground page embeds in the
 * model description. It sits inside a JSON-escaped markdown string, so rows
 * are joined by a literal `\n` (backslash, n) rather than a newline; returned
 * as plain markdown.
 */
export function descriptionSizeTable(html: string): string | null {
  const lines = html.split(/\\+n|\n/);
  const start = lines.findIndex((l) => /^\s*\|\s*size\s*\|/i.test(l));
  if (start < 0) return null;
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.trimStart().startsWith('|')) break;
    rows.push(line.trim());
  }
  return rows.length > 1 ? rows.join('\n') : null;
}

/** Pricing sections that point at the page description carry a table there. */
const DEFERS_TO_DESCRIPTION = /see the description/i;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** ~55 sequential GETs a night inside a 15-minute cron: one hung fal response must not eat it. */
const FETCH_TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn(`rate-card source: HTTP ${resp.status} for ${url}`);
      return null;
    }
    return await resp.text();
  } catch (error) {
    logger.warn(`rate-card source: request failed for ${url}`, {
      err: error,
    });
    return null;
  }
}

export async function fetchRateCardSource(
  endpointId: string
): Promise<RateCardSourceResult> {
  const url = llmsTxtUrl(endpointId);
  const llmsTxt = await fetchText(url);
  if (llmsTxt == null) return { status: 'failed' };
  const pricingSection = llmsTxtPricingSection(llmsTxt);
  if (!pricingSection) {
    logger.warn(`${endpointId}: llms.txt has no Pricing section`);
    return { status: 'no-pricing' };
  }
  const inputSchemaSection = llmsTxtInputSchemaSection(llmsTxt) ?? '';

  let descriptionTable: string | undefined;
  if (DEFERS_TO_DESCRIPTION.test(pricingSection)) {
    const html = await fetchText(`https://fal.ai/models/${endpointId}`);
    if (html == null) return { status: 'failed' };
    descriptionTable = descriptionSizeTable(html) ?? undefined;
    if (!descriptionTable) {
      logger.warn(
        `${endpointId}: Pricing defers to the description but the page has no size table`
      );
    }
  }

  const text = descriptionTable
    ? `${pricingSection}\n\n${descriptionTable}`
    : pricingSection;
  return {
    status: 'ok',
    source: {
      endpointId,
      url,
      pricingSection,
      inputSchemaSection,
      ...(descriptionTable && { descriptionTable }),
      text,
      hash: await sha256Hex(text),
    },
  };
}
