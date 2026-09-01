/**
 * Draft a studio prompt from the attached references (#1274).
 *
 * A vision LLM sees the attached stills (clips contribute only their label —
 * the chat adapter takes image parts) and writes a one-shot prompt that binds
 * each reference by its `@ImageN` / `@VideoN` / `@AudioN` token, in the bare
 * form the composer's pills store (`Image1`, not `@Image1`). The `image`
 * activity is supported but not yet reachable from the composer.
 */

import type { Microdollars } from '@/lib/billing/money';
import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import {
  aiObservabilityMiddleware,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';
import type { ChatMessage } from '@/lib/prompts';
import type { StudioActivity, StudioReferenceKind } from '@/lib/studio/schema';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { chat } from '@tanstack/ai';
import { createAdapter } from './create-adapter';
import {
  createUsageCapture,
  extractRunError,
  llmCostFromUsage,
  throwNotedRunError,
} from './llm-client';
import { DEFAULT_VISION_MODEL } from './models.config';

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
  observability?: AIObservabilityMeta;
};

type DraftStudioPromptResult = {
  prompt: string;
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
  const adapter = createAdapter(STUDIO_DRAFT_MODEL, input.llmKey);
  const usageCapture = createUsageCapture();
  let text = '';
  let runError = null;
  for await (const event of chat({
    adapter,
    systemPrompts,
    messages: messages.map((m) => ({
      role: m.role === 'system' ? ('user' as const) : m.role,
      content: m.content,
    })),
    stream: true,
    modelOptions: { temperature: 0.7, streamOptions: { includeUsage: true } },
    middleware: [
      ...aiObservabilityMiddleware({
        observationName: 'studio-prompt-draft',
        tags: ['vision', 'studio'],
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
      text += event.delta;
    }
  }
  throwNotedRunError(runError);

  // Strip any @ the model added anyway; pills store the bare token.
  const prompt = text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/@(Image|Video|Audio)(\d+)/g, '$1$2');
  if (!prompt) throw new Error('The draft came back empty — try again.');

  return {
    prompt,
    costMicros: llmCostFromUsage(usageCapture.get(), STUDIO_DRAFT_MODEL),
    usedOwnKey: input.llmKey?.source === 'team',
  };
}
