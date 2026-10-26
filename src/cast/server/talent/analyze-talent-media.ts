/**
 * Billed likeness-vision calls on a photo or a stored clip. Upload
 * classification (`classifyUpload`) is the only caller: it decides whether
 * the media shows a real person before the rights gate.
 */

import {
  analyzeTalentClip,
  analyzeTalentMedia,
  TALENT_CLIP_MODEL,
  TALENT_VISION_MODEL,
  type TalentVisionResult,
} from '@/cast/server/talent-vision';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { estimateLLMCost } from '@/billing/cost-estimation';
import type { ScopedDb } from '@/platform/server/db/scoped';

/**
 * What a billed vision call reads and writes. Narrow so a request and a
 * workflow (`UploadCheckWorkflow`, through its named hatches) both satisfy it.
 */
export type VisionBillingDb = {
  apiKeys: Pick<ScopedDb['apiKeys'], 'resolveLlmKey'>;
  billing: Pick<ScopedDb['billing'], 'hasEnoughCredits' | 'deductCredits'>;
};
import { InsufficientCreditsError, ValidationError } from '@/platform/errors';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import {
  deleteGeminiFile,
  uploadClipToGemini,
} from '@/models/server/gemini-files';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cast', 'talent-vision']);

export type AnalyzeTalentMediaForTeamInput = {
  scopedDb: VisionBillingDb;
  userId: string;
  imageUrls: string[];
  filenames?: string[];
  idempotencyKey: string;
};

export async function analyzeTalentMediaForTeam(
  input: AnalyzeTalentMediaForTeamInput
): Promise<TalentVisionResult> {
  const llmKeyInfo =
    await input.scopedDb.apiKeys.resolveLlmKey(TALENT_VISION_MODEL);
  await requireVisionCredits(input.scopedDb, llmKeyInfo);
  const result = await analyzeTalentMedia({
    imageUrls: input.imageUrls,
    filenames: input.filenames,
    llmKey: llmKeyInfo,
    // The region fallback swaps the model; re-resolve so the retry's via is
    // one that carries it (#1259).
    resolveLlmKey: (model) => input.scopedDb.apiKeys.resolveLlmKey(model),
    observability: {
      userId: input.userId,
      tags: ['vision', 'likeness'],
    },
  });
  await billTalentVision(input, result, input.imageUrls.length);
  return result;
}

/**
 * The same check on a stored clip (#1930): Gemini watches the whole clip
 * through its Files API. Needs a native Google key (the team's or the
 * platform's); with none the clip is refused, never judged by another model.
 */
export async function analyzeTalentClipForTeam(input: {
  scopedDb: VisionBillingDb;
  userId: string;
  /** Storage key of the clip (`<bucket>/<path>`). */
  key: string;
  mimeType: string;
  idempotencyKey: string;
}): Promise<TalentVisionResult> {
  const llmKey = await input.scopedDb.apiKeys.resolveLlmKey(TALENT_CLIP_MODEL);
  if (llmKey.via !== 'google') {
    throw new ValidationError(
      'Checking a clip for a real person needs a Gemini API key. Add one in Settings → API Keys.'
    );
  }
  await requireVisionCredits(input.scopedDb, llmKey);
  const file = await uploadClipToGemini(input.key, input.mimeType, llmKey.key);
  try {
    const result = await analyzeTalentClip({
      clip: file,
      llmKey,
      observability: { userId: input.userId, tags: ['vision', 'likeness'] },
    });
    await billTalentVision(input, result, 1);
    return result;
  } finally {
    await deleteGeminiFile(file.name, llmKey.key).catch((error: unknown) => {
      logger.warn('Could not delete a clip from Gemini Files', {
        name: file.name,
        error,
      });
    });
  }
}

async function requireVisionCredits(
  scopedDb: VisionBillingDb,
  llmKey: ResolvedLlmKey
): Promise<void> {
  if (llmKey.source === 'team') return;
  const canAfford = await scopedDb.billing.hasEnoughCredits(estimateLLMCost(1));
  if (!canAfford) {
    throw new InsufficientCreditsError(
      'Insufficient credits for talent vision'
    );
  }
}

async function billTalentVision(
  input: { scopedDb: VisionBillingDb; idempotencyKey: string },
  result: TalentVisionResult,
  mediaCount: number
): Promise<void> {
  if (result.usedOwnKey) return;
  if (result.costMicros > 0) {
    await input.scopedDb.billing.deductCredits(result.costMicros, {
      description: `Talent vision (${result.model})`,
      metadata: { model: result.model },
      idempotencyKey: input.idempotencyKey,
    });
  } else {
    reportMissingBillingCost({
      source: 'talent-vision',
      modelId: result.model,
      metadata: { imageCount: mediaCount },
    });
  }
}
