/**
 * Element Vision Helper
 *
 * Describes an uploaded element image using a vision-capable LLM via
 * @tanstack/ai's OpenRouter adapter.
 */

import type { Microdollars } from '@/lib/billing/money';
import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import {
  aiObservabilityMiddleware,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';
import type { ChatMessage, ChatMessageImagePart } from '@/lib/prompts';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import { createAdapter } from './create-adapter';
import {
  createUsageCapture,
  extractRunError,
  llmCostFromUsage,
  throwNotedRunError,
} from './llm-client';
import { DEFAULT_VISION_MODEL } from './models.config';

export const ELEMENT_VISION_MODEL = DEFAULT_VISION_MODEL;

export const elementVisionResponseSchema = z.object({
  description: z.string().min(1),
  consistencyTag: z.string().min(1),
  suggestedToken: z.string().min(1),
});

type ElementDescription = z.infer<typeof elementVisionResponseSchema>;

export type DescribeElementInput = {
  imageUrl: string;
  filename: string;
  /** Resolved LLM key (team OpenRouter, team fal, or platform) */
  llmKey?: ResolvedLlmKey;
  /** PostHog LLM-analytics metadata for the generation span. */
  observability?: AIObservabilityMeta;
};

export type ElementVisionResult = ElementDescription & {
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

  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') systemPrompts.push(msg.content);
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const adapter = createAdapter(ELEMENT_VISION_MODEL, input.llmKey);

  // Stream structured output so OpenRouter attaches usage.cost (TanStack/ai#1076).
  const usageCapture = createUsageCapture();
  let structuredObject: unknown;
  let accumulated = '';
  let runError = null;
  for await (const event of chat({
    adapter,
    systemPrompts,
    messages: chatMessages,
    stream: true,
    modelOptions: {
      temperature: 0.3,
      streamOptions: { includeUsage: true },
    },
    outputSchema: elementVisionResponseSchema,
    middleware: [
      ...aiObservabilityMiddleware({
        observationName: 'element-vision',
        tags: ['vision'],
        ...input.observability,
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
      continue;
    }
    if (
      event.type === 'CUSTOM' &&
      event.name === 'structured-output.complete'
    ) {
      structuredObject = event.value.object;
      continue;
    }
  }
  throwNotedRunError(runError);

  const parsed = elementVisionResponseSchema.parse(
    structuredObject !== undefined ? structuredObject : JSON.parse(accumulated)
  );
  return {
    ...parsed,
    suggestedToken: normalizeSuggestedToken(parsed.suggestedToken),
    costMicros: llmCostFromUsage(usageCapture.get(), ELEMENT_VISION_MODEL),
    usedOwnKey: input.llmKey?.source === 'team',
  };
}
