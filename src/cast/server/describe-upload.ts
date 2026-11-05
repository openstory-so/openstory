/**
 * A description of an uploaded character or location image (#2254), to fill
 * the new-character and new-location forms. Elements have their own
 * (`describeElementImage`). Only an upload that passed the likeness check is
 * described.
 */

import { reportMissingBillingCost } from '@/billing/billing-observability';
import { estimateLLMCost } from '@/billing/cost-estimation';
import {
  requireCheckable,
  requireUploadRights,
} from '@/cast/server/upload-rights';
import { DEFAULT_VISION_MODEL } from '@/models/models.config';
import { callLLMStream, llmCostFromUsage } from '@/models/server/llm-client';
import { InsufficientCreditsError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { UploadRightsReader } from '@/cast/server/upload-rights';
import type { VisionBillingDb } from '@/cast/server/talent/analyze-talent-media';
import { toVisionImageSource } from '@/platform/server/storage/external-url';
import { z } from 'zod';

export type UploadSubject = 'character' | 'location';

const responseSchema = z.object({ description: z.string() });

const SYSTEM_PROMPTS: Record<UploadSubject, string> = {
  character: `You describe a character from one image (a photo or a character sheet) for a film production's character bible. Write how the character looks so an image model can draw them again: apparent age, build, face, skin, hair, and any marks such as scars or tattoos. 30-70 words, plain prose, no name. Do not describe clothing, pose, background, lighting or the photograph. Return JSON: {"description": "..."}.`,
  location: `You describe a place from one photo for a film production's location bible. Write what the place is and how it looks so an image model can draw it again: kind of place, period, layout, architecture, materials, colours and notable fixtures. 30-70 words, plain prose. Do not describe people, weather, lighting or the camera. Return JSON: {"description": "..."}.`,
};

export async function describeUpload(opts: {
  scopedDb: Pick<ScopedDb, 'organizationId'> &
    UploadRightsReader &
    VisionBillingDb;
  userId: string;
  url: string;
  filename: string;
  subject: UploadSubject;
}): Promise<{ description: string }> {
  const { scopedDb } = opts;
  requireCheckable(opts.url, scopedDb.organizationId);
  await requireUploadRights(scopedDb, [opts.url]);

  const llmKey = await scopedDb.apiKeys.resolveLlmKey(DEFAULT_VISION_MODEL);
  if (
    llmKey.source !== 'organization' &&
    !(await scopedDb.billing.hasEnoughCredits(estimateLLMCost(1)))
  ) {
    throw new InsufficientCreditsError(
      'Insufficient credits to describe the image'
    );
  }

  let parsed: z.infer<typeof responseSchema> | undefined;
  let usage;
  let model = DEFAULT_VISION_MODEL;
  let via = llmKey.via;
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
    responseSchema,
    apiKey: llmKey,
    resolveApiKey: (m) => scopedDb.apiKeys.resolveLlmKey(m),
    observationName: `${opts.subject}-upload-vision`,
    tags: ['vision'],
    userId: opts.userId,
  })) {
    if (chunk.done) {
      parsed = chunk.parsed;
      usage = chunk.usage;
      model = chunk.model;
      via = chunk.via;
    }
  }
  const description = parsed?.description.trim();
  if (!description) throw new Error('Vision returned no description');

  if (llmKey.source !== 'organization') {
    const costMicros = llmCostFromUsage(usage, model, via);
    if (costMicros > 0) {
      await scopedDb.billing.deductCredits(costMicros, {
        description: `Upload description (${model})`,
        metadata: { model, subject: opts.subject },
        idempotencyKey: `describe-upload:${opts.subject}:${opts.url}`,
      });
    } else {
      reportMissingBillingCost({
        source: 'describe-upload',
        modelId: model,
        metadata: { subject: opts.subject },
      });
    }
  }
  return { description };
}
