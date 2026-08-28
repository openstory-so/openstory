/**
 * Billed talent-vision call used by server fns and library-talent create.
 */

import {
  analyzeTalentMedia,
  TALENT_VISION_MODEL,
  type TalentMediaAnalysis,
  type TalentVisionResult,
} from '@/lib/ai/talent-vision';
import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';

export type AnalyzeTalentMediaForTeamInput = {
  scopedDb: ScopedDb;
  userId: string;
  imageUrls: string[];
  filenames?: string[];
  idempotencyKey: string;
};

export async function analyzeTalentMediaForTeam(
  input: AnalyzeTalentMediaForTeamInput
): Promise<TalentVisionResult> {
  const llmKeyInfo = await input.scopedDb.apiKeys.resolveLlmKey();
  if (llmKeyInfo.source !== 'team') {
    const estimatedCost = estimateLLMCost(1);
    const canAfford =
      await input.scopedDb.billing.hasEnoughCredits(estimatedCost);
    if (!canAfford) {
      throw new InsufficientCreditsError(
        'Insufficient credits for talent vision'
      );
    }
  }

  const result = await analyzeTalentMedia({
    imageUrls: input.imageUrls,
    filenames: input.filenames,
    llmKey: llmKeyInfo,
    observability: {
      userId: input.userId,
      tags: ['vision', 'talent'],
    },
  });

  if (!result.usedOwnKey) {
    if (result.costMicros > 0) {
      await input.scopedDb.billing.deductCredits(result.costMicros, {
        description: `Talent vision (${TALENT_VISION_MODEL})`,
        metadata: { model: TALENT_VISION_MODEL },
        idempotencyKey: input.idempotencyKey,
      });
    } else {
      reportMissingBillingCost({
        source: 'talent-vision',
        modelId: TALENT_VISION_MODEL,
        metadata: { imageCount: input.imageUrls.length },
      });
    }
  }

  return result;
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return slug.length > 0 ? slug : 'talent';
}

export function sheetMetadataFromAnalysis(
  name: string,
  analysis: TalentMediaAnalysis
): CharacterBibleEntry {
  const slug = slugifyName(name);
  return {
    characterId: slug,
    name,
    age: analysis.age,
    gender: analysis.gender,
    ethnicity: analysis.ethnicity,
    physicalDescription:
      analysis.physicalDescription.trim() || analysis.description,
    standardClothing: analysis.standardClothing,
    distinguishingFeatures: analysis.distinguishingFeatures,
    consistencyTag: slug,
  };
}
