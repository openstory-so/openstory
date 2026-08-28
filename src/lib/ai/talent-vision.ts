/**
 * Talent reference vision helper.
 *
 * Classifies uploaded talent media as a character/talent sheet vs a regular
 * photo, and describes appearance so we can fill a talent description and
 * sheet metadata without a second model call.
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
import { talentSubjectKindSchema } from '@/lib/talent/subject-kind';

export const TALENT_VISION_MODEL = DEFAULT_VISION_MODEL;

export const talentMediaAnalysisSchema = z.object({
  isCharacterSheet: z.boolean(),
  subjectKind: talentSubjectKindSchema,
  suggestedName: z.string(),
  description: z.string(),
  age: z.string(),
  gender: z.string(),
  ethnicity: z.string(),
  physicalDescription: z.string(),
  standardClothing: z.string(),
  distinguishingFeatures: z.string(),
});

export type TalentMediaAnalysis = z.infer<typeof talentMediaAnalysisSchema>;

export type AnalyzeTalentMediaInput = {
  imageUrls: string[];
  /**
   * Original upload filenames, same order as `imageUrls`. Appended to the
   * user message so e2e aimock can key photo vs sheet vs creature fixtures
   * (the mock matches `userMessage`, not image bytes).
   */
  filenames?: string[];
  llmKey?: ResolvedLlmKey;
  observability?: AIObservabilityMeta;
};

export type TalentVisionResult = TalentMediaAnalysis & {
  costMicros: Microdollars;
  usedOwnKey: boolean;
};

const SYSTEM_PROMPT = `You are a talent reference analyst for a film/video production tool. You will be shown one or more images stored as library talent — a real person, an illustrated or 3D character, a creature, or similar.

First classify WHAT the subject is. Do NOT default to human.

- "human": a real or photoreal identifiable person (a photograph, or a photoreal render of a specific human).
- "animated": illustration, cartoon, anime, 3D/CGI character, robot, puppet, or other clearly non-photographic character.
- "other": animal, creature, mascot, object, or anything that is not a human likeness and not a stylized character.

A drawing, character-design sheet, robot, or stylized CGI figure is never "human".

Then decide whether the image (or any of the images) is already a CHARACTER SHEET / TALENT SHEET, and describe the subject so a later image model can reproduce them.

A character/talent sheet is a technical reference grid of the SAME subject from multiple camera angles — typically 3–4 panels in a horizontal row (full-body front, close-up portrait, side profile, rear) on a clean studio or seamless backdrop. It is NOT: a single portrait, a casual photo, a comic page, a contact sheet of different subjects, an ID document, or a collage of unrelated photos.

Output MUST be strict JSON with these fields:
- "subjectKind": "human" | "animated" | "other" as defined above.
- "isCharacterSheet": true only when the image is clearly that multi-view reference grid of one subject.
- "suggestedName": a short display name if one is inferable (otherwise "").
- "description": 40-90 words covering face/body (or equivalent), typical clothing or materials, and distinguishing marks. Do NOT describe studio lighting, panel layout, or the photograph itself.
- "age", "gender", "ethnicity": short strings; use "" if unknown or not applicable.
- "physicalDescription": face, hair, build, skin, eyes — or the equivalent for a non-human subject.
- "standardClothing": wardrobe or surface materials visible in the image(s).
- "distinguishingFeatures": scars, tattoos, jewelry, unique traits; "" if none.

Return ONLY the JSON object.`;

function filenameSuffix(filenames?: string[]): string {
  if (!filenames?.length) return '';
  const cleaned = filenames.map((name) =>
    name.replace(/[\r\n]+/g, ' ').slice(0, 255)
  );
  return `\nUploaded filename: ${cleaned.join(', ')}`;
}

/** Build multimodal messages. Exported for tests. */
export function buildTalentVisionMessages(
  imageSources: ChatMessageImagePart['source'][],
  filenames?: string[]
): ChatMessage[] {
  const count = imageSources.length;
  const userText =
    (count === 1
      ? 'Analyze this talent reference: is the image already a character sheet? Describe the person.'
      : `Analyze this talent reference: are any of these ${count} images already a character sheet? Describe the person.`) +
    filenameSuffix(filenames);

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', content: userText },
        ...imageSources.map((source): ChatMessageImagePart => ({
          type: 'image',
          source,
        })),
      ],
    },
  ];
}

export async function analyzeTalentMedia(
  input: AnalyzeTalentMediaInput
): Promise<TalentVisionResult> {
  if (input.imageUrls.length === 0) {
    throw new Error('At least one image URL is required');
  }

  const imageSources = await Promise.all(
    input.imageUrls.map((url) => toVisionImageSource(url))
  );
  const messages = buildTalentVisionMessages(imageSources, input.filenames);

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

  const adapter = createAdapter(TALENT_VISION_MODEL, input.llmKey);

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
      temperature: 0.2,
      streamOptions: { includeUsage: true },
    },
    outputSchema: talentMediaAnalysisSchema,
    middleware: [
      ...aiObservabilityMiddleware({
        observationName: 'talent-vision',
        tags: ['vision', 'talent'],
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

  const parsed = talentMediaAnalysisSchema.parse(
    structuredObject !== undefined ? structuredObject : JSON.parse(accumulated)
  );
  return {
    ...parsed,
    costMicros: llmCostFromUsage(usageCapture.get(), TALENT_VISION_MODEL),
    usedOwnKey: input.llmKey?.source === 'team',
  };
}
