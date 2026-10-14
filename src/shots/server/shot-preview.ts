/**
 * A shot's storyboard preview: the grey animatic sketch on the scene rail
 * (#1101, #1642). Scene split draws one per shot. A reference-only shot has
 * no still, so the sketch is the only picture of it until the clip lands, and
 * it is drawn again whenever the motion prompt changes. For a reference-only
 * shot that prompt is the same framing, action and camera text the sketch is
 * drawn from (`deriveMotionPrompt`). A shot with a start frame shows its
 * still, so its sketch is never redrawn.
 */
import { estimateImageCost, gateEstimate } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { requireCredits } from '@/billing/server/preflight';
import { dressForScene } from '@/cast/character-looks';
import { charactersToBible } from '@/cast/server/bibles-from-scoped';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/models/aspect-ratios';
import { SHOT_PREVIEW_IMAGE_MODEL } from '@/models/models';
import { simpleHash } from '@/platform/hash';
import { getLogger } from '@/platform/logger';
import type { EnforcementRow } from '@/platform/server/compliance/enforcement';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { ImageWorkflowInput } from '@/platform/server/workflow/types';
import { buildPreviewPrompt } from '@/sequences/server/poster-prompt';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import type { ShotEditContext } from './shot-context';

const logger = getLogger(['openstory', 'shots', 'shot-preview']);

type PreviewTarget = {
  userId: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  frameId: string;
  aspectRatio: AspectRatio;
  /** Built by `buildPreviewPrompt`. */
  prompt: string;
  /** The run envelope this spends, when a parent run holds one. */
  reservationId?: string;
};

/** Start one preview render. It lands as the frame's newest `kind: 'preview'` row. */
export function triggerShotPreview(
  target: PreviewTarget,
  options?: {
    deduplicationId?: string;
    enforcement?: readonly EnforcementRow[];
  }
): Promise<string> {
  return triggerWorkflow(
    '/image',
    {
      userId: target.userId,
      teamId: target.teamId,
      sequenceId: target.sequenceId,
      prompt: target.prompt,
      model: SHOT_PREVIEW_IMAGE_MODEL,
      imageSize: aspectRatioToImageSize(target.aspectRatio),
      numImages: 1,
      shotId: target.shotId,
      frameId: target.frameId,
      skipStorage: true,
      variantOnly: false,
      reservationId: target.reservationId,
    } satisfies ImageWorkflowInput,
    options
  );
}

async function previewCostMicros(aspectRatio: AspectRatio) {
  return gateEstimate(
    estimateImageCost(SHOT_PREVIEW_IMAGE_MODEL, aspectRatio, 1, {
      pricing: await getEffectiveFalPricing(),
    }),
    { model: SHOT_PREVIEW_IMAGE_MODEL, operation: 'shot-preview' }
  );
}

/**
 * Redraw a reference-only shot's sketch from its new motion prompt, after an
 * edit has saved it. Skipped when the sketch would come out of the same
 * prompt. Never throws: the edit is already saved, and a failure here must
 * not report it as failed. The old sketch stays up, and the warning says why.
 */
export async function redrawShotPreview(
  context: Pick<
    ShotEditContext,
    'scopedDb' | 'user' | 'teamId' | 'shot' | 'frame' | 'sequence' | 'scene'
  >,
  motionPrompt: string
): Promise<void> {
  const { scopedDb, user, teamId, shot, frame, sequence, scene } = context;
  if (!rendersReferenceOnly(shot, sequence)) return;
  try {
    const characters = await scopedDb.characters.list(sequence.id);
    const prompt = buildPreviewPrompt(
      motionPrompt,
      charactersToBible(
        dressForScene(characters, scene?.continuity?.characterLooks)
      )
    );
    const latest = await scopedDb.frameVariants.getLatestPreview(frame.id);
    if (latest?.promptHash === simpleHash(prompt)) return;
    await requireCredits(
      scopedDb,
      await previewCostMicros(sequence.aspectRatio)
    );
    await triggerShotPreview({
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      frameId: frame.id,
      aspectRatio: sequence.aspectRatio,
      prompt,
    });
  } catch (error) {
    logger.warn(
      `Preview redraw for shot ${shot.id} did not start; its old sketch stays up`,
      { err: error }
    );
  }
}

/**
 * The same redraw from inside a run (Rewrite shot). The run cannot read the
 * frame's latest preview, so it always redraws: a rewrite always writes a new
 * spec. `deduplicationId` keeps a replayed step from drawing twice.
 */
export async function redrawShotPreviewInRun(
  scopedDb: WorkflowScopedDb,
  target: Omit<PreviewTarget, 'prompt'> & {
    motionPrompt: string;
    characterBible: readonly CharacterBibleEntry[];
    deduplicationId: string;
  }
): Promise<void> {
  try {
    await requireCredits(
      scopedDb.liveRead,
      await previewCostMicros(target.aspectRatio),
      { reservationId: target.reservationId }
    );
    await triggerShotPreview(
      {
        ...target,
        prompt: buildPreviewPrompt(target.motionPrompt, target.characterBible),
      },
      {
        deduplicationId: target.deduplicationId,
        enforcement: await scopedDb.liveRead.compliance.listEnforcementFor(
          target.userId,
          target.teamId
        ),
      }
    );
  } catch (error) {
    logger.warn(
      `Preview redraw for shot ${target.shotId} did not start; its old sketch stays up`,
      { err: error }
    );
  }
}
