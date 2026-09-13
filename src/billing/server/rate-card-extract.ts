/**
 * LLM extraction of a rate card from an endpoint's source text (#1605).
 *
 * One non-workflow structured call per endpoint, only when the priced text
 * changed (the cron compares `source.hash`). The model's output is a trust
 * boundary: it is validated with `rateCardSchema`, every worked example in
 * the text must reproduce within 1% (`verifyRateCardExamples`), and the
 * default-input price must sit in a sane range — or the card is rejected
 * with a warn log. A card the text gives no examples for is stored
 * unverified. Never a billing input.
 *
 * No `outputSchema`: the card is recursive JSONLogic over records, which
 * Anthropic-strict structured output cannot express (and the schema-budget
 * sweep would refuse), so the model writes the JSON as text and zod parses it.
 */
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import { RATE_CARDS } from '@/billing/rate-card/cards';
import {
  evaluateRateCard,
  type ExampleResult,
  RateCardError,
  verifyRateCardExamples,
} from '@/billing/rate-card/evaluate';
import {
  CARD_LEVEL_PARAMS,
  type Expr,
  type RateCard,
  rateCardSchema,
} from '@/billing/rate-card/rate-card.schema';
import { type Microdollars, ZERO_MICROS } from '@/billing/money';
import type { TextModel } from '@/models/models';
import { createAdapter, type LlmKeyInfo } from '@/models/server/create-adapter';
import {
  createUsageCapture,
  extractRunError,
  llmCostFromUsage,
  throwNotedRunError,
} from '@/models/server/llm-client';
import { getChatPrompt } from '@/platform/server/ai/prompts-index';
import { getLogger } from '@/platform/logger';
import { aiObservabilityMiddleware } from '@/platform/server/observability/ai-otel';
import type { RateCardSource } from './rate-card-source';

const logger = getLogger(['openstory', 'ai', 'rate-card-extract']);

/** Strong reasoning model: the card is a small program, not a summary. */
export const RATE_CARD_EXTRACTION_MODEL: TextModel =
  'google/gemini-3.1-pro-preview';

/** Bounds on the price of a default request — outside is a misread card. */
export const DEFAULT_PRICE_BOUNDS_USD = { min: 0.0001, max: 50 };

/** What the model returns; `source` is stamped here, not by the model. */
const extractionOutputSchema = rateCardSchema.omit({ source: true }).extend({
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
});

/**
 * Two hand cards of different shapes (per-second tiers with a lever the
 * schema has no field for; per-image multipliers + surcharges) shown with
 * the text they were read from, so the model sees a finished transcription.
 */
const FEW_SHOT: { endpointId: string; pricing: string; schema: string }[] = [
  {
    endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
    pricing:
      'For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.168** (audio on), if voice control is used while generating audio you will be charged **$0.196**. For example, a 5s video with audio on and voice control will cost **$0.98**',
    schema:
      '- **`duration`** (`DurationEnum`, _optional_): The duration of the generated video in seconds Default value: `"5"`\n  - Options: `"3"`, `"4"`, `"5"`, …, `"15"`\n- **`generate_audio`** (`boolean`, _optional_): Whether to generate native audio for the video. Default value: `true`',
  },
  {
    endpointId: 'fal-ai/nano-banana-2',
    pricing:
      'Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged.',
    schema:
      '- **`num_images`** (`integer`, _optional_): Default value: `1`\n- **`resolution`** (`ResolutionEnum`, _optional_): Default value: `"1K"`\n  - Options: `"0.5K"`, `"1K"`, `"2K"`, `"4K"`\n- **`enable_web_search`** (`boolean`, _optional_): Default value: `false`\n- **`thinking_level`** (`ThinkingLevelEnum`, _optional_):\n  - Options: `"minimal"`, `"high"`',
  },
];

function fewShotText(): string {
  return FEW_SHOT.map(({ endpointId, pricing, schema }) => {
    const card = RATE_CARDS[endpointId];
    if (!card) throw new Error(`few-shot card missing: ${endpointId}`);
    const { source: _source, ...body } = card;
    return `<EXAMPLE endpoint="${endpointId}">\n<PRICING>\n${pricing}\n</PRICING>\n<INPUT_SCHEMA>\n${schema}\n</INPUT_SCHEMA>\n<RATE_CARD>\n${JSON.stringify(body)}\n</RATE_CARD>\n</EXAMPLE>`;
  }).join('\n\n');
}

/** Exported for the prompt test and the local runner. */
export async function buildExtractionMessages(
  source: RateCardSource,
  today: string
) {
  return getChatPrompt('billing/rate-card-extraction-chat', {
    today,
    endpointId: source.endpointId,
    pricingSection: source.pricingSection,
    descriptionTable: source.descriptionTable ?? '(none)',
    inputSchemaSection: source.inputSchemaSection || '(none)',
    jsonSchema: JSON.stringify(z.toJSONSchema(rateCardSchema)),
    cardLevelParams: CARD_LEVEL_PARAMS.map((p) => `"${p}"`).join(', '),
    fewShot: fewShotText(),
  });
}

/** Param names an llms.txt `### Input Schema` section declares. */
export function inputSchemaParams(inputSchemaSection: string): Set<string> {
  return new Set(
    [...inputSchemaSection.matchAll(/^- \*\*`([^`]+)`\*\*/gm)].flatMap((m) =>
      m[1] ? [m[1]] : []
    )
  );
}

/**
 * Verification is circular for a lever the model invented: it also writes
 * the examples that exercise it. So every bound param and every example
 * key must be a schema param (or a known card-level lever) — the card that
 * dropped H3 Max's reference surcharge bound `reference_tokens` and passed
 * its own examples 100%.
 */
function unknownParams(
  card: Pick<RateCard, 'inputs' | 'examples'>,
  schema: Set<string>
): string[] {
  const allowed = new Set([...schema, ...CARD_LEVEL_PARAMS]);
  const bound = Object.values(card.inputs).map((i) => i.param);
  const exampled = card.examples.flatMap((e) => Object.keys(e.params));
  return [...new Set([...bound, ...exampled])].filter((p) => !allowed.has(p));
}

/** A `lookup` default is a neighbour's price for a shape the text never priced. */
function hasLookupDefault(expr: Expr): boolean {
  if (typeof expr !== 'object') return false;
  if ('lookup' in expr) {
    return (
      expr.lookup.default !== undefined ||
      expr.lookup.keys.some(hasLookupDefault)
    );
  }
  return Object.values(expr).some((arg) =>
    Array.isArray(arg)
      ? arg.some(hasLookupDefault)
      : arg !== undefined && hasLookupDefault(arg)
  );
}

/** Strip a ```json fence if the model added one despite the instruction. */
function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(trimmed);
}

export type RateCardExtraction =
  | {
      status: 'ok';
      card: RateCard;
      verified: boolean;
      results: ExampleResult[];
      costMicros: Microdollars;
    }
  | {
      status: 'rejected';
      reason: string;
      /** The call itself failed (outage, timeout) — retry tonight's text tomorrow. */
      transient?: boolean;
      results?: ExampleResult[];
      costMicros: Microdollars;
    };

/** USD of a request that sends only the card's defaults, or null if one is required. */
function defaultPriceUsd(card: RateCard): number | null {
  try {
    return evaluateRateCard(card, {}).usd;
  } catch (error) {
    if (error instanceof RateCardError && error.code === 'bad-input') {
      return null;
    }
    throw error;
  }
}

/** Run the model once; its text and the call's cost. */
async function callExtractionModel(
  source: RateCardSource,
  today: string,
  llmKey: LlmKeyInfo | undefined
): Promise<{ text: string; costMicros: Microdollars }> {
  const { messages } = await buildExtractionMessages(source, today);
  const systemPrompts = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''));
  const chatMessages = messages.flatMap((m) =>
    m.role === 'system' ? [] : [{ role: m.role, content: m.content }]
  );

  const adapter = createAdapter(RATE_CARD_EXTRACTION_MODEL, llmKey);
  const usageCapture = createUsageCapture();
  let accumulated = '';
  let runError = null;
  for await (const event of chat({
    adapter,
    systemPrompts,
    messages: chatMessages,
    stream: true,
    modelOptions: { temperature: 0, streamOptions: { includeUsage: true } },
    middleware: [
      ...aiObservabilityMiddleware({
        observationName: 'rate-card-extraction',
        tags: ['billing', 'rate-card'],
        metadata: { endpointId: source.endpointId },
      }),
      ...usageCapture.middleware,
    ],
    debug: false,
  })) {
    usageCapture.noteFromStreamEvent(event);
    const noted = extractRunError(event);
    if (noted) {
      runError ??= noted;
      continue;
    }
    if (
      event.type === 'TEXT_MESSAGE_CONTENT' &&
      typeof event.delta === 'string'
    ) {
      accumulated += event.delta;
    }
  }
  throwNotedRunError(runError);
  return {
    text: accumulated,
    costMicros: llmCostFromUsage(
      usageCapture.get(),
      RATE_CARD_EXTRACTION_MODEL,
      llmKey?.via
    ),
  };
}

/**
 * Extract, validate and verify one endpoint's card. `previous` is the stored
 * card, for the unchanged-text diff log. Model errors surface as `rejected`
 * so one endpoint cannot fail the whole refresh.
 */
export async function extractRateCard(
  source: RateCardSource,
  opts: {
    llmKey?: LlmKeyInfo;
    /** ISO date the promo rule is judged against; defaults to today. */
    today?: string;
    previous?: RateCard;
    now?: Date;
  } = {}
): Promise<RateCardExtraction> {
  const now = opts.now ?? new Date();
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const { endpointId } = source;
  const reject = (
    reason: string,
    costMicros: Microdollars,
    results?: ExampleResult[],
    transient = false
  ): RateCardExtraction => {
    logger.warn(`${endpointId}: rate card rejected — ${reason}`);
    return { status: 'rejected', reason, costMicros, results, transient };
  };

  let text: string;
  let costMicros: Microdollars = ZERO_MICROS;
  try {
    ({ text, costMicros } = await callExtractionModel(
      source,
      today,
      opts.llmKey
    ));
  } catch (error) {
    // The call, not the card: an outage is retried on the same text.
    return reject(
      `extraction call failed: ${error instanceof Error ? error.message : String(error)}`,
      costMicros,
      undefined,
      true
    );
  }

  let raw: unknown;
  try {
    raw = parseJsonText(text);
  } catch (error) {
    return reject(
      `output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      costMicros
    );
  }

  const parsed = extractionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return reject(
      `output does not fit the rate-card schema: ${z.prettifyError(parsed.error)}`,
      costMicros
    );
  }
  const { expiresAt, ...body } = parsed.data;
  const unknown = unknownParams(
    body,
    inputSchemaParams(source.inputSchemaSection)
  );
  if (unknown.length > 0) {
    return reject(
      `binds params the Input Schema does not declare: ${unknown.join(', ')}`,
      costMicros
    );
  }
  if (hasLookupDefault(body.price)) {
    return reject(
      'a lookup carries a default — an unpriced shape must refuse, not borrow a neighbour',
      costMicros
    );
  }
  // A promo end already behind us would force a re-extraction every night.
  const expires =
    expiresAt && new Date(expiresAt) > now
      ? new Date(expiresAt).toISOString()
      : undefined;
  const card: RateCard = {
    ...body,
    source: {
      url: source.url,
      hash: source.hash,
      extractedAt: now.toISOString(),
      ...(expires && { expiresAt: expires }),
    },
  };

  const results = verifyRateCardExamples(card);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    return reject(
      `worked example did not reproduce: "${failed[0]?.example.quote}" → ${failed[0]?.error}`,
      costMicros,
      results
    );
  }

  let defaultUsd: number | null;
  try {
    defaultUsd = defaultPriceUsd(card);
  } catch (error) {
    return reject(
      `default request does not evaluate: ${error instanceof Error ? error.message : String(error)}`,
      costMicros,
      results
    );
  }
  if (
    defaultUsd != null &&
    (defaultUsd < DEFAULT_PRICE_BOUNDS_USD.min ||
      defaultUsd > DEFAULT_PRICE_BOUNDS_USD.max)
  ) {
    return reject(
      `default request prices at $${defaultUsd}, outside [$${DEFAULT_PRICE_BOUNDS_USD.min}, $${DEFAULT_PRICE_BOUNDS_USD.max}]`,
      costMicros,
      results
    );
  }

  const previous = opts.previous;
  if (previous && previous.source.hash === source.hash) {
    const same = (a: RateCard, b: RateCard) =>
      JSON.stringify([a.inputs, a.tables, a.price]) ===
      JSON.stringify([b.inputs, b.tables, b.price]);
    if (!same(previous, card)) {
      logger.warn(
        `${endpointId}: re-extraction changed the card without the source text changing`,
        {
          previousDefaultUsd: defaultPriceUsd(previous),
          nextDefaultUsd: defaultUsd,
          previousPrice: previous.price,
          nextPrice: card.price,
        }
      );
    }
  }

  const verified = results.length > 0;
  if (!verified) {
    logger.warn(
      `${endpointId}: rate card stored unverified — the text states no worked example`
    );
  }
  return { status: 'ok', card, verified, results, costMicros };
}
