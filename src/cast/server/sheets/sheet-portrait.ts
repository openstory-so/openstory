/**
 * The square portrait drawn from a sheet, for tiles and avatars.
 *
 * A sheet is several panels, laid out differently by every model, so a fixed
 * crop shows a border, a caption or the wrong panel. One cheap image call
 * redraws the subject as a single square, with the sheet as its reference.
 * It is made wherever a sheet version is made (a sheet run, an upload) and
 * stored on that version row, so it follows whichever sheet is selected.
 */

import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/billing/server/workflow-deduction';
import { estimateImageCost, gateEstimate } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { generateImageWithProvider } from '@/stills/server/image-generation';
import { storeGeneratedPng } from '@/stills/server/image-storage';

const logger = getLogger(['openstory', 'cast', 'sheet-portrait']);

/** The cheapest still model that takes a reference image. */
const PORTRAIT_MODEL = 'nano_banana_2_lite';

type PortraitKind = 'character' | 'location';

const PORTRAIT: Record<
  PortraitKind,
  { prompt: string; bucket: StorageBucket }
> = {
  character: {
    prompt:
      'This is a character reference sheet. Make one square head-and-shoulders portrait of this exact character: same face, hair, skin, wardrobe, same rendering style and lighting. Face centred, looking at camera, plain background taken from the sheet. One image only: no panels, no borders, no text, no labels.',
    bucket: STORAGE_BUCKETS.CHARACTERS,
  },
  location: {
    prompt:
      'This is a location reference sheet of several views. Make one square establishing image of this exact place: same architecture, materials, palette, light and rendering style. The most recognisable view of it, subject centred. One image only: no panels, no borders, no text, no labels.',
    bucket: STORAGE_BUCKETS.LOCATIONS,
  },
};

/**
 * Draw and store the portrait of one sheet. Null when the team cannot pay
 * for it or the draw failed: the sheet is the artifact that matters and
 * still lands, and tiles crop it as they did before portraits. Inside a
 * workflow, call it in one `step.do`: the image is stored before the step
 * returns (#1645), and the charge is keyed on `chargeKey` so a replay cannot
 * charge twice.
 *
 * The balance is checked before the paid call, against funds no run holds:
 * a sheet run's reservation covers the sheet, not this. A team's own key
 * does not lift the check, because which key serves this model is only
 * known once the call returns.
 */
export async function drawSheetPortrait(args: {
  scopedDb: WorkflowScopedDb;
  kind: PortraitKind;
  sheetUrl: string;
  /** The folder the sheet itself is stored under. */
  storageDir: string;
  /** The character or sequence location the sheet is of, for the audit row. */
  subjectId: string;
  /** The run drawing it: keys the charge and names the run on the audit row. */
  chargeKey: string;
  userId: string;
  sequenceId: string | null;
}): Promise<string | null> {
  const { scopedDb, kind, sheetUrl } = args;
  const { prompt, bucket } = PORTRAIT[kind];
  try {
    const estimate = gateEstimate(
      estimateImageCost(PORTRAIT_MODEL, '1:1', 1, {
        pricing: await getEffectiveFalPricing(),
        edit: true,
      }),
      { model: PORTRAIT_MODEL, operation: 'sheet-portrait' }
    );
    if (!(await scopedDb.liveRead.billing.hasEnoughCredits(estimate))) {
      logger.info(
        `No credits for the ${kind} sheet portrait; tiles crop the sheet`
      );
      return null;
    }
    const result = await generateImageWithProvider(
      {
        model: PORTRAIT_MODEL,
        prompt,
        imageSize: 'square_hd',
        numImages: 1,
        referenceImageUrls: [sheetUrl],
      },
      { scopedDb }
    );
    const stored = await storeGeneratedPng(
      result.imageUrls[0],
      bucket,
      `${args.storageDir}/${generateId()}-portrait.png`
    );
    // Before the charge: an image with no audit row is not kept (#1180).
    await recordProvenance(scopedDb.provenance, {
      teamId: scopedDb.teamId,
      userId: args.userId,
      assetKind: kind === 'character' ? 'character_sheet' : 'location_sheet',
      assetId: args.subjectId,
      storageKey: stored.path,
      provider: result.via,
      model: PORTRAIT_MODEL,
      providerRequestId: result.metadata.requestId ?? null,
      workflowRunId: args.chargeKey,
      prompt,
      sequenceId: args.sequenceId ?? undefined,
      referenceImageCount: 1,
    });
    await deductWorkflowCredits({
      scopedDb,
      costMicros: extractImageCost(result.metadata),
      usedOwnKey: result.metadata.usedOwnKey,
      description: `Sheet portrait (${PORTRAIT_MODEL})`,
      idempotencyKey: `${args.chargeKey}:portrait`,
      metadata: {
        model: PORTRAIT_MODEL,
        kind,
        sequenceId: args.sequenceId,
        userId: args.userId,
      },
      workflowName: 'SheetPortrait',
    });
    return stored.url;
  } catch (error) {
    logger.warn(`Portrait not drawn for ${kind} sheet; tiles crop the sheet`, {
      err: error,
      sheetUrl,
    });
    return null;
  }
}
