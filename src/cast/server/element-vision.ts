/**
 * Element Vision Helper
 *
 * Describes an uploaded element image using a vision-capable LLM via
 * @tanstack/ai's OpenRouter adapter.
 */

import type { Microdollars } from '@/billing/money';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import type { TextModel } from '@/models/models';
import type { AIObservabilityMeta } from '@/platform/server/observability/ai-otel';
import type {
  ChatMessage,
  ChatMessageImagePart,
} from '@/platform/server/ai/prompts-index';
import { toVisionImageSource } from '@/platform/server/storage/external-url';
import { z } from 'zod';
import { callLLMStream, llmCostFromUsage } from '@/models/server/llm-client';
import { DEFAULT_VISION_MODEL } from '@/models/models.config';

export const ELEMENT_VISION_MODEL = DEFAULT_VISION_MODEL;

/**
 * LLM wire shape. Plain `z.string()` — Anthropic rejects `minLength` /
 * `maxLength` (#1410). Empty description/consistencyTag are rejected after
 * parse in `describeElementImage`; empty `suggestedToken` becomes `ELEMENT`.
 */
export const elementVisionResponseSchema = z.object({
  description: z.string(),
  consistencyTag: z.string(),
  suggestedToken: z.string(),
});

type ElementDescription = z.infer<typeof elementVisionResponseSchema>;

export type DescribeElementInput = {
  imageUrl: string;
  filename: string;
  /** Resolved LLM key (team OpenRouter, team fal, or platform) */
  llmKey?: ResolvedLlmKey;
  /**
   * Re-resolve the key when a region block swaps the model (#1259). `llmKey`
   * was resolved for {@link ELEMENT_VISION_MODEL}; the fallback may not be
   * carried by the same via.
   */
  resolveLlmKey?: (model: TextModel) => Promise<ResolvedLlmKey>;
  /** PostHog LLM-analytics metadata for the generation span. */
  observability?: AIObservabilityMeta;
};

export type ElementVisionResult = ElementDescription & {
  /** The model that actually answered — the region fallback may have run
   *  instead of {@link ELEMENT_VISION_MODEL}. Bill and log this one. */
  model: TextModel;
  costMicros: Microdollars;
  usedOwnKey: boolean;
};

/**
 * Normalize a vision-suggested token to canonical UPPERCASE_SNAKE_CASE.
 * Drops everything outside `[A-Z0-9]`, collapses runs to `_`, caps length.
 */
function normalizeSuggestedToken(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return cleaned.length > 0 ? cleaned : 'ELEMENT';
}

/**
 * Build the multimodal chat messages for the vision LLM.
 * Exported for testing.
 */
function buildVisionMessages(
  filename: string,
  imageSource: ChatMessageImagePart['source']
): ChatMessage[] {
  const system = `You are a visual reference describer. You will be shown a single image that will serve as a canonical reference for an element (logo, product, screenshot, or similar object) in a film/video production. Your job is to describe what the image visually contains so that AI image generators can later reproduce the element faithfully across scenes, AND to suggest a concise UPPERCASE token that a screenwriter would type to reference this element in a script.

Your output MUST be strict JSON with three fields:
- "description": 60-120 words. Describe shape, proportions, colors, text rendered on the element (verbatim), finish/material, any distinguishing marks, and how it is oriented. Do NOT describe background, lighting, camera angle, or the overall photograph — only the element itself.
- "consistencyTag": A lowercase slug (3-6 words joined by hyphens) capturing the element's visual identity for reuse in prompts (e.g. "red-hex-brand-logo", "silver-metal-water-bottle").
- "suggestedToken": A short UPPERCASE_SNAKE_CASE identifier (1-3 words, joined by underscores, max 30 characters) naming the element so a screenwriter can reference it. If the uploaded filename looks deliberately named by a person, derive the token from it (e.g. "acme-logo.png" → "ACME_LOGO", "red water bottle.jpg" → "RED_WATER_BOTTLE"). Ignore auto-generated filenames (e.g. "IMG_1234.jpg", "Screenshot 2026-05-01.png", "image.png", "download.jpg", random hashes) — for those, prefer brand/product names visible in the image (e.g. "PEPSI_LOGO", "IPHONE", "STARBUCKS_CUP"); if no brand text is visible, name the object descriptively (e.g. "RED_BOTTLE", "OFFICE_CHAIR"). Letters and digits only; no spaces, dashes, or punctuation.

Return ONLY the JSON object. No prose, no markdown fences.`;

  const userText = `Uploaded filename: ${filename}

Describe the element in the image below and suggest a token.`;

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', content: userText },
        { type: 'image', source: imageSource },
      ],
    },
  ];
}

export async function describeElementImage(
  input: DescribeElementInput
): Promise<ElementVisionResult> {
  // Local /r2/ URLs aren't reachable by real OpenRouter — inline the image
  // bytes as a data part instead (no-op in prod and e2e replay).
  const imageSource = await toVisionImageSource(input.imageUrl);
  const messages = buildVisionMessages(input.filename, imageSource);

  // Centralized call (see talent-vision): the #1259 region fallback, the
  // OpenRouter provider pin that keeps this schema on a host advertising
  // `structured_outputs` (#1285), the priority service tier, and a `low`
  // reasoning effort on the GLM-5.3 Flash fallback, which otherwise thinks at
  // `max` (#1494).
  let parsed: ElementDescription | undefined;
  let usage;
  let model = ELEMENT_VISION_MODEL;
  let via = input.llmKey?.via;
  for await (const chunk of callLLMStream({
    model: ELEMENT_VISION_MODEL,
    messages,
    temperature: 0.3,
    responseSchema: elementVisionResponseSchema,
    apiKey: input.llmKey,
    resolveApiKey: input.resolveLlmKey,
    observationName: 'element-vision',
    tags: ['vision'],
    ...input.observability,
  })) {
    if (chunk.done) {
      parsed = chunk.parsed;
      usage = chunk.usage;
      model = chunk.model;
      via = chunk.via;
    }
  }
  if (!parsed) {
    throw new Error('Element vision returned no validated description');
  }

  const description = parsed.description.trim();
  const consistencyTag = parsed.consistencyTag.trim();
  if (!description || !consistencyTag) {
    throw new Error(
      'Element vision returned empty description or consistencyTag'
    );
  }
  return {
    description,
    consistencyTag,
    suggestedToken: normalizeSuggestedToken(parsed.suggestedToken),
    model,
    costMicros: llmCostFromUsage(usage, model, via),
    usedOwnKey: input.llmKey?.source === 'team',
  };
}
