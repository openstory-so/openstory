/**
 * Draft a studio prompt from the attached references (#1274).
 *
 * A vision LLM sees the attached stills (clips contribute only their label —
 * the chat adapter takes image parts) and writes a one-shot prompt that binds
 * each reference by its `@ImageN` / `@VideoN` / `@AudioN` token, in the bare
 * form the composer's pills store (`Image1`, not `@Image1`). The `image`
 * activity is supported but not yet reachable from the composer.
 */

import type { Microdollars } from '@/billing/money';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import type { TextModel } from '@/models/models';
import type { AIObservabilityMeta } from '@/platform/server/observability/ai-otel';
import type { ChatMessage } from '@/platform/server/ai/prompts-index';
import type { StudioActivity, StudioReferenceKind } from '@/studio/schema';
import { toVisionImageSource } from '@/platform/server/storage/external-url';
import { callLLMStream, llmCostFromUsage } from '@/models/server/llm-client';
import { DEFAULT_VISION_MODEL } from '@/models/models.config';

export const STUDIO_DRAFT_MODEL = DEFAULT_VISION_MODEL;

type DraftReference = {
  url: string;
  label: string;
  kind: StudioReferenceKind;
};

export type DraftStudioPromptInput = {
  activity: StudioActivity;
  /** Attached references in `@Image1`… order, per kind. */
  references: DraftReference[];
  /** Frames mode: start (and optional end) frame. */
  startImageUrl?: string;
  endImageUrl?: string;
  /** What the user has typed so far, if anything — kept as intent. */
  currentPrompt?: string;
  llmKey?: ResolvedLlmKey;
  /**
   * Re-resolve the key when a region block swaps the model (#1259). `llmKey`
   * was resolved for {@link STUDIO_DRAFT_MODEL}; the fallback may not be
   * carried by the same via.
   */
  resolveLlmKey?: (model: TextModel) => Promise<ResolvedLlmKey>;
  observability?: AIObservabilityMeta;
};

type DraftStudioPromptResult = {
  prompt: string;
  /** The model that actually answered — the region fallback may have run
   *  instead of {@link STUDIO_DRAFT_MODEL}. Bill and log this one. */
  model: TextModel;
  costMicros: Microdollars;
  usedOwnKey: boolean;
};

function tokensFor(references: DraftReference[]): string[] {
  const counts = { image: 0, video: 0, audio: 0 };
  return references.map((ref) => {
    counts[ref.kind] += 1;
    const prefix =
      ref.kind === 'image' ? 'Image' : ref.kind === 'video' ? 'Video' : 'Audio';
    return `${prefix}${counts[ref.kind]}`;
  });
}

export async function buildDraftMessages(
  input: DraftStudioPromptInput
): Promise<{ systemPrompts: string[]; messages: ChatMessage[] }> {
  const tokens = tokensFor(input.references);
  const frames = input.startImageUrl
    ? [
        { url: input.startImageUrl, token: 'the start frame' },
        ...(input.endImageUrl
          ? [{ url: input.endImageUrl, token: 'the end frame' }]
          : []),
      ]
    : [];

  const system =
    input.activity === 'video'
      ? `You write prompts for an AI video generator. Write ONE prompt of 40-90 words describing a single continuous shot: subject, action, camera move, lighting, mood. Plain prose, present tense, no headings, no lists, no quotes.

Every attached reference has a token. Refer to a reference ONLY by its bare token (for example: Image1, Video2, Audio1) exactly where it should appear — a character token where the character acts, a location token for the setting, a video token for motion or style to follow, an audio token for what should play. Use each token at least once. Never write the @ sign. Never describe a reference in detail — the token stands for it.`
      : `You write prompts for an AI image generator. Write ONE prompt of 30-70 words: subject, composition, lighting, style. Plain prose, no headings, no lists, no quotes.`;

  const parts: ChatMessage['content'] = [];
  const lines: string[] = [];
  for (const [index, ref] of input.references.entries()) {
    const token = tokens[index] ?? '';
    lines.push(`${token}: ${ref.kind} — "${ref.label}"`);
    if (ref.kind === 'image') {
      parts.push({ type: 'text', content: `${token}:` });
      parts.push({ type: 'image', source: await toVisionImageSource(ref.url) });
    }
  }
  for (const frame of frames) {
    lines.push(`${frame.token}`);
    parts.push({ type: 'text', content: `${frame.token}:` });
    parts.push({ type: 'image', source: await toVisionImageSource(frame.url) });
  }

  const intent = input.currentPrompt?.trim();
  // Nothing attached and nothing typed: "Try something random" on an empty
  // composer (#1393). There is no brief to follow, so ask for an invention
  // outright rather than sending a bare "References:" header with no rows.
  const fromNothing = lines.length === 0 && !intent;
  const userText = [
    ...(fromNothing
      ? [
          'Nothing is attached and nothing has been written. Invent the idea: pick a specific subject, place and moment you find interesting — an unexpected one, not the first cliché that comes to mind.',
        ]
      : ['References:', ...lines]),
    ...(frames.length > 0
      ? [
          'Describe the motion from the start frame' +
            (input.endImageUrl ? ' to the end frame.' : '.'),
        ]
      : []),
    ...(intent ? [`The user's own notes, keep their intent: "${intent}"`] : []),
    'Write the prompt now.',
  ].join('\n');

  return {
    systemPrompts: [system],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', content: userText }, ...parts],
      },
    ],
  };
}

export async function draftStudioPrompt(
  input: DraftStudioPromptInput
): Promise<DraftStudioPromptResult> {
  const { systemPrompts, messages } = await buildDraftMessages(input);

  // Centralized call (see talent-vision): the #1259 region fallback, the
  // OpenRouter provider pin, the priority service tier, and a `low` reasoning
  // effort on the GLM-5.3 Flash fallback, which cannot disable thinking and
  // defaults to `max` (#1494) — a composer draft must not stall for minutes.
  let text = '';
  let usage;
  let model = STUDIO_DRAFT_MODEL;
  let via = input.llmKey?.via;
  for await (const chunk of callLLMStream({
    model: STUDIO_DRAFT_MODEL,
    messages: [
      ...systemPrompts.map((content) => ({
        role: 'system' as const,
        content,
      })),
      ...messages.map((m) => ({
        role: m.role === 'system' ? ('user' as const) : m.role,
        content: m.content,
      })),
    ],
    temperature: 0.7,
    apiKey: input.llmKey,
    resolveApiKey: input.resolveLlmKey,
    observationName: 'studio-prompt-draft',
    tags: ['vision', 'studio'],
    ...input.observability,
  })) {
    text = chunk.accumulated;
    if (chunk.done) {
      usage = chunk.usage;
      model = chunk.model;
      via = chunk.via;
    }
  }

  // Strip any @ the model added anyway; pills store the bare token.
  const prompt = text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/@(Image|Video|Audio)(\d+)/g, '$1$2');
  if (!prompt) throw new Error('The draft came back empty — try again.');

  return {
    prompt,
    model,
    costMicros: llmCostFromUsage(usage, model, via),
    usedOwnKey: input.llmKey?.source === 'team',
  };
}
