/**
 * A description of an uploaded character or location image (#2254), to fill
 * the new-character and new-location forms. Elements have their own
 * (`describeElementImage`). Only an upload that passed the likeness check is
 * described.
 */

import { forCall } from '@/gateway/server/text';
import type { TextModel } from '@/models/models';
import { estimateLLMCost } from '@/billing/cost-estimation';
import {
  requireCheckable,
  requireUploadRights,
} from '@/cast/server/upload-rights';
import { DEFAULT_VISION_MODEL } from '@/models/models.config';
import { callLLMStream } from '@/models/server/llm-client';
import { InsufficientCreditsError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { UploadRightsReader } from '@/cast/server/upload-rights';
import type { VisionBillingDb } from '@/cast/server/talent/analyze-talent-media';
import { toVisionImageSource } from '@/platform/server/storage/external-url';
import { z } from 'zod';

export type UploadSubject = 'character' | 'location';

const responseSchema = z.object({
  description: z.string(),
  isCharacterSheet: z.boolean(),
});

const SYSTEM_PROMPTS: Record<UploadSubject, string> = {
  character: `You describe a character from one image (a photo or a character sheet) for a film production's character bible. Write how the character looks so an image model can draw them again: apparent age, build, face, skin, hair, and any marks such as scars or tattoos. 30-70 words, plain prose, no name. Do not describe clothing, pose, background, lighting or the photograph. Also say whether the image is already a character sheet (several views of the character side by side on a plain background) rather than a single photo or picture. Return JSON: {"description": "...", "isCharacterSheet": true|false}.`,
  location: `You describe a place from one photo for a film production's location bible. Write what the place is and how it looks so an image model can draw it again: kind of place, period, layout, architecture, materials, colours and notable fixtures. 30-70 words, plain prose. Do not describe people, weather, lighting or the camera. Return JSON: {"description": "...", "isCharacterSheet": false}.`,
};

export async function describeUpload(opts: {
  scopedDb: Pick<ScopedDb, 'organizationId'> &
    UploadRightsReader &
    VisionBillingDb;
  userId: string;
  url: string;
  filename: string;
  subject: UploadSubject;
}): Promise<{
  description: string;
  /** A character image that is already a sheet; null for a location. */
  isCharacterSheet: boolean | null;
}> {
  const { scopedDb } = opts;
  requireCheckable(opts.url, scopedDb.organizationId);
  await requireUploadRights(scopedDb, [opts.url]);

  const keyFor = async (model: TextModel) =>
    forCall(await scopedDb.apiKeys.resolveLlmKey(model), {
      describe: (answered) => `Upload description (${answered})`,
    });
  const llmKey = await keyFor(DEFAULT_VISION_MODEL);
  if (
    llmKey.source !== 'organization' &&
    !(await scopedDb.billing.hasEnoughCredits(estimateLLMCost(1)))
  ) {
    throw new InsufficientCreditsError(
      'Insufficient credits to describe the image'
    );
  }

  let parsed: z.infer<typeof responseSchema> | undefined;
  for await (const chunk of callLLMStream({
    model: DEFAULT_VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPTS[opts.subject] },
      {
        role: 'user',
        content: [
          { type: 'text', content: `Uploaded filename: ${opts.filename}` },
          { type: 'image', source: await toVisionImageSource(opts.url) },
        ],
      },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    responseSchema,
    apiKey: llmKey,
    resolveApiKey: keyFor,
    observationName: `${opts.subject}-upload-vision`,
    tags: ['vision'],
    userId: opts.userId,
  })) {
    if (chunk.done) parsed = chunk.parsed;
  }
  const description = parsed?.description.trim();
  if (!parsed || !description) {
    throw new Error('Vision returned no description');
  }
  const isCharacterSheet =
    opts.subject === 'character' ? parsed.isCharacterSheet : null;

  return { description, isCharacterSheet };
}
