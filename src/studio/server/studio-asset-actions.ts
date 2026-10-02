/**
 * Studio asset actions shared by `studio-assets.fn.ts` and the MCP Studio
 * tools (#1985): favourite, delete, edit history and the AI prompt draft.
 */

import { reportMissingBillingCost } from '@/billing/billing-observability';
import { estimateLLMCost } from '@/billing/cost-estimation';
import { InsufficientCreditsError, NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  STORAGE_BUCKETS,
  r2KeyFromUrl,
} from '@/platform/server/storage/buckets';
import { deleteFile } from '@/platform/server/storage/storage-cloudflare';
import type { StudioPromptDraftInput } from '@/studio/schema';
import {
  draftStudioPrompt,
  STUDIO_DRAFT_MODEL,
} from '@/studio/server/studio-prompt-draft';

const logger = getLogger(['openstory', 'studio', 'assets']);

/** This team's studio row, or not found. */
async function requireStudioAsset(scopedDb: ScopedDb, id: string) {
  const asset = await scopedDb.generatedAssets.getById(id);
  if (!asset || asset.source !== 'studio') {
    throw new NotFoundError('Generated asset not found');
  }
  return asset;
}

export async function setStudioAssetFavorite(
  scopedDb: ScopedDb,
  id: string,
  isFavorite: boolean
): Promise<{ id: string; isFavorite: boolean }> {
  await requireStudioAsset(scopedDb, id);
  await scopedDb.generatedAssets.setFavorite(id, isFavorite);
  return { id, isFavorite };
}

export async function deleteStudioAsset(
  scopedDb: ScopedDb,
  id: string
): Promise<{ id: string }> {
  const asset = await requireStudioAsset(scopedDb, id);
  await scopedDb.generatedAssets.delete(id);
  // Storage deletion is best-effort: a leaked object beats a failed delete.
  for (const { url } of asset.outputs ?? []) {
    const key = r2KeyFromUrl(url);
    if (!key) continue;
    const bucket = key.startsWith(`${STORAGE_BUCKETS.VIDEOS}/`)
      ? STORAGE_BUCKETS.VIDEOS
      : STORAGE_BUCKETS.THUMBNAILS;
    await deleteFile(bucket, key.slice(bucket.length + 1)).catch((err) =>
      logger.warn('Failed to delete studio asset object', { err, key })
    );
  }
  return { id };
}

/** Longest edit chain walked; a cycle cannot form, this bounds a bad row. */
const MAX_EDIT_HISTORY = 50;

export type StudioEditHistoryEntry = {
  id: string;
  prompt: string;
  modelName: string;
  edit: boolean;
  createdAt: Date;
};

/**
 * The prompts a clip was made from (#1925), oldest first: the original, then
 * each edit (`input.sourceAssetId`) down to this clip. A deleted ancestor
 * ends the walk.
 */
export async function getStudioEditHistory(
  scopedDb: ScopedDb,
  assetId: string
): Promise<StudioEditHistoryEntry[]> {
  const history: StudioEditHistoryEntry[] = [];
  let id: string | undefined = assetId;
  while (id && history.length < MAX_EDIT_HISTORY) {
    const asset = await scopedDb.generatedAssets.getById(id);
    if (!asset || asset.source !== 'studio') break;
    const { prompt, sourceAssetId, mode } = asset.input;
    history.unshift({
      id: asset.id,
      prompt: typeof prompt === 'string' ? prompt : '',
      modelName: asset.modelName,
      edit: mode === 'edit',
      createdAt: asset.createdAt,
    });
    id = typeof sourceAssetId === 'string' ? sourceAssetId : undefined;
  }
  return history;
}

/**
 * Draft a prompt from the attached references. Billed like element vision:
 * credit-gated on the platform key, charged from reported usage.
 */
export async function draftStudioPromptForTeam(
  scopedDb: ScopedDb,
  data: StudioPromptDraftInput
): Promise<{ prompt: string }> {
  const llmKey = await scopedDb.apiKeys.resolveLlmKey(STUDIO_DRAFT_MODEL);
  if (llmKey.source !== 'team') {
    const canAfford = await scopedDb.billing.hasEnoughCredits(
      estimateLLMCost(1)
    );
    if (!canAfford) {
      throw new InsufficientCreditsError(
        'Insufficient credits to draft a prompt'
      );
    }
  }

  const result = await draftStudioPrompt({
    ...data,
    llmKey,
    resolveLlmKey: (model) => scopedDb.apiKeys.resolveLlmKey(model),
    observability: { userId: scopedDb.userId, tags: ['studio', 'draft'] },
  });

  if (!result.usedOwnKey) {
    if (result.costMicros > 0) {
      await scopedDb.billing.deductCredits(result.costMicros, {
        description: `Studio prompt draft (${result.model})`,
        metadata: { model: result.model },
      });
    } else {
      reportMissingBillingCost({
        source: 'studio-prompt-draft',
        modelId: result.model,
        metadata: { references: data.references.length },
      });
    }
  }
  return { prompt: result.prompt };
}
