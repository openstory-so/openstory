/**
 * The square portrait drawn from a sheet, for tiles and avatars.
 *
 * A sheet is several panels, laid out differently by every model, so a fixed
 * crop shows a border, a caption or the wrong panel. One cheap image call
 * redraws the subject as a single square, with the sheet as its reference.
 * It is made wherever a sheet version is made (a sheet run, an upload) and
 * stored on that version row, so it follows whichever sheet is selected.
 */

import { deleteFile } from '#storage';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import type { Microdollars } from '@/billing/money';
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
 * returns (#1645).
 *
 * The money, in order:
 * - A hold for the estimate is taken before the paid call. A sheet run's
 *   reservation covers the sheet, not this, and a check with no hold would
 *   let two runs spend one balance. No hold, no call. A team's own key does
 *   not lift it: which key serves this model is known only once the call
 *   returns.
 *   A hold found already spent or released (a replay of a run that got
 *   this far before) is no hold either.
 * - The team pays only for a portrait it gets. A call that fails, or an
 *   image that could not be stored or recorded, releases the hold and costs
 *   nothing; neither is something a user can cause.
 * - An image is kept only with its audit row (#1180): one that could not be
 *   recorded is deleted, and the tile crops.
 * - The charge is its own step (`chargeSheetPortrait`): a charge that fails
 *   retries on its own and never draws again.
 */
export type DrawnPortrait = {
  readonly portraitUrl: string;
  readonly costMicros: Microdollars;
  readonly usedOwnKey: boolean;
  readonly reservationId: string;
};

export async function drawSheetPortrait(args: {
  scopedDb: WorkflowScopedDb;
  kind: PortraitKind;
  sheetUrl: string;
  /** The folder the sheet itself is stored under. */
  storageDir: string;
  /** The character or sequence location the sheet is of, for the audit row. */
  subjectId: string;
  /** The run drawing it: keys the hold and the charge, and names the run. */
  chargeKey: string;
  userId: string;
  sequenceId: string | null;
}): Promise<DrawnPortrait | null> {
  const { scopedDb, kind, sheetUrl } = args;
  const { prompt, bucket } = PORTRAIT[kind];

  const estimate = gateEstimate(
    estimateImageCost(PORTRAIT_MODEL, '1:1', 1, {
      pricing: await getEffectiveFalPricing(),
      edit: true,
    }),
    { model: PORTRAIT_MODEL, operation: 'sheet-portrait' }
  );
  const hold = await scopedDb.billing.createReservation(estimate, {
    idempotencyKey: `${args.chargeKey}:portrait-hold`,
    sequenceId: args.sequenceId ?? undefined,
  });
  // `ok` on a replay only says the row exists: it must still hold the money.
  if (!hold.ok || hold.remaining < estimate) {
    logger.info(
      `No credits for the ${kind} sheet portrait; tiles crop the sheet`
    );
    return null;
  }

  let result: Awaited<ReturnType<typeof generateImageWithProvider>>;
  try {
    result = await generateImageWithProvider(
      {
        model: PORTRAIT_MODEL,
        prompt,
        imageSize: 'square_hd',
        numImages: 1,
        referenceImageUrls: [sheetUrl],
      },
      // The credentials half, as every workflow image call passes it.
      { scopedDb: scopedDb.credentials }
    );
  } catch (error) {
    await scopedDb.billing.zeroReservation(hold.reservationId);
    logger.warn(`Portrait not drawn for ${kind} sheet; tiles crop the sheet`, {
      err: error,
      sheetUrl,
    });
    return null;
  }

  const path = `${args.storageDir}/${generateId()}-portrait.png`;
  let portraitUrl: string;
  try {
    const stored = await storeGeneratedPng(result.imageUrls[0], bucket, path);
    try {
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
    } catch (error) {
      await deleteFile(bucket, path);
      throw error;
    }
    portraitUrl = stored.url;
  } catch (error) {
    await scopedDb.billing.zeroReservation(hold.reservationId);
    logger.error(`Portrait drawn for ${kind} sheet but not kept; not charged`, {
      err: error,
      sheetUrl,
    });
    return null;
  }

  return {
    portraitUrl,
    costMicros: extractImageCost(result.metadata),
    usedOwnKey: result.metadata.usedOwnKey,
    reservationId: hold.reservationId,
  };
}

/**
 * Charge for a portrait that was drawn and kept, then give back what the
 * hold did not use. Throws when the charge cannot be taken, so its step
 * retries with the hold still in place; keyed on `chargeKey`, so a replay
 * charges once.
 */
export async function chargeSheetPortrait(args: {
  scopedDb: WorkflowScopedDb;
  drawn: DrawnPortrait;
  kind: PortraitKind;
  chargeKey: string;
  userId: string;
  sequenceId: string | null;
}): Promise<void> {
  const { scopedDb, drawn } = args;
  await deductWorkflowCredits({
    scopedDb,
    costMicros: drawn.costMicros,
    usedOwnKey: drawn.usedOwnKey,
    description: `Sheet portrait (${PORTRAIT_MODEL})`,
    idempotencyKey: `${args.chargeKey}:portrait`,
    reservationId: drawn.reservationId,
    metadata: {
      model: PORTRAIT_MODEL,
      kind: args.kind,
      sequenceId: args.sequenceId,
      userId: args.userId,
    },
    workflowName: 'SheetPortrait',
  });
  // What the charge did not take goes back to the balance.
  await scopedDb.billing.zeroReservation(drawn.reservationId);
}
