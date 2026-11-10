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
import { ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { FrameVariant } from '@/platform/server/db/schema';
import type { EnforcementRow } from '@/platform/server/compliance/enforcement';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { ImageWorkflowInput } from '@/platform/server/workflow/types';
import {
  buildPreviewPrompt,
  previewTextForShot,
} from '@/sequences/server/poster-prompt';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import type { ShotEditContext } from './shot-context';

const logger = getLogger(['openstory', 'shots', 'shot-preview']);

type PreviewTarget = {
  userId: string;
  organizationId: string;
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
      organizationId: target.organizationId,
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

type PreviewContext = Pick<
  ShotEditContext,
  | 'scopedDb'
  | 'user'
  | 'organizationId'
  | 'shot'
  | 'frame'
  | 'sequence'
  | 'scene'
>;

/** The cast a sketch draws: the sequence's characters, dressed for the scene. */
async function previewCast(context: PreviewContext) {
  const characters = await context.scopedDb.characters.list(
    context.sequence.id
  );
  return charactersToBible(
    dressForScene(characters, context.scene?.continuity?.characterLooks)
  );
}

async function startPreview(context: PreviewContext, prompt: string) {
  const { scopedDb, user, organizationId, shot, frame, sequence } = context;
  await requireCredits(scopedDb, await previewCostMicros(sequence.aspectRatio));
  return triggerShotPreview({
    userId: user.id,
    organizationId,
    sequenceId: sequence.id,
    shotId: shot.id,
    frameId: frame.id,
    aspectRatio: sequence.aspectRatio,
    prompt,
  });
}

/**
 * Redraw a reference-only shot's sketch from its new motion prompt, after an
 * edit has saved it. Skipped when the sketch would come out of the same
 * prompt. Never throws: the edit is already saved, and a failure here must
 * not report it as failed. The old sketch stays up and reads stale (#2350).
 */
export async function redrawShotPreview(
  context: PreviewContext,
  motionPrompt: string
): Promise<void> {
  const { scopedDb, shot, frame, sequence } = context;
  if (!rendersReferenceOnly(shot, sequence)) return;
  try {
    const prompt = buildPreviewPrompt(motionPrompt, await previewCast(context));
    const latest = await scopedDb.frameVariants.getLatestPreview(frame.id);
    if (latest?.promptHash === simpleHash(prompt)) return;
    await startPreview(context, prompt);
  } catch (error) {
    logger.warn(
      `Preview redraw for shot ${shot.id} did not start; its old sketch stays up`,
      { err: error }
    );
  }
}

/**
 * The sketch prompts that count as current: the one a redraw draws now (the
 * selected motion prompt) and the one scene split draws (the spec). A sketch
 * from either is not stale.
 */
async function currentPreviewPrompts(context: PreviewContext) {
  const { scopedDb, shot, scene } = context;
  const [cast, motion, spec] = await Promise.all([
    previewCast(context),
    scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
    scopedDb.shotSpecVersions.getSelected(shot.id),
  ]);
  const fromSpec = scene
    ? buildPreviewPrompt(
        previewTextForShot(
          {
            shots: spec ? [{ ...spec.spec, shotNumber: 1 }] : [],
            originalScript: { extract: scene.originalScript?.extract ?? '' },
            metadata: {
              title: scene.metadata?.title ?? '',
              location: '',
              timeOfDay: '',
            },
          },
          1
        ),
        cast
      )
    : null;
  const fromMotion = motion?.text
    ? buildPreviewPrompt(motion.text, cast)
    : null;
  return { draw: fromMotion ?? fromSpec, fromSpec, fromMotion };
}

type StoryboardStaleReason = 'missing' | 'failed' | 'changed';

/**
 * A reference-only shot's storyboard (#2350): the sketch on show, whether it
 * is stale and why, and every sketch drawn for it, newest first. History is
 * view-only; the newest completed sketch always shows.
 */
export async function readShotStoryboard(context: PreviewContext) {
  const { scopedDb, shot, frame, sequence } = context;
  const referenceOnly = rendersReferenceOnly(shot, sequence);
  const [rows, prompts] = await Promise.all([
    scopedDb.frameVariants.listPreviews(frame.id),
    referenceOnly ? currentPreviewPrompts(context) : null,
  ]);
  const current =
    rows.find((row) => row.status === 'completed' && row.url) ?? null;
  const newest = rows[0] ?? null;
  const generating =
    newest?.status === 'generating' || newest?.status === 'pending';
  const fresh = [prompts?.fromMotion, prompts?.fromSpec]
    .filter((prompt): prompt is string => !!prompt)
    .map(simpleHash);
  const staleReason: StoryboardStaleReason | null =
    !prompts || generating
      ? null
      : !current
        ? 'missing'
        : newest?.status === 'failed'
          ? 'failed'
          : !current.promptHash || !fresh.includes(current.promptHash)
            ? 'changed'
            : null;
  return {
    shotId: shot.id,
    referenceOnly,
    generating,
    staleReason,
    current: current && storyboardSketch(current),
    history: rows.map(storyboardSketch),
  };
}

function storyboardSketch(row: FrameVariant) {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    error: row.status === 'failed' ? row.error : null,
    model: row.model,
    createdAt: row.createdAt,
  };
}

/**
 * Draw a reference-only shot's sketch again now, from the prompt a redraw
 * would use. Unlike the automatic redraw, a failure to start throws.
 */
export async function regenerateShotStoryboard(context: PreviewContext) {
  const { scopedDb, shot, frame, sequence } = context;
  if (!rendersReferenceOnly(shot, sequence)) {
    throw new ValidationError(
      'This shot uses a start frame; its still is its picture.'
    );
  }
  const newest = (await scopedDb.frameVariants.listPreviews(frame.id, 1))[0];
  if (newest?.status === 'generating' || newest?.status === 'pending') {
    return { workflowRunId: newest.workflowRunId, alreadyInFlight: true };
  }
  const { draw } = await currentPreviewPrompts(context);
  if (!draw)
    throw new ValidationError('Shot has nothing to draw a sketch from');
  const workflowRunId = await startPreview(context, draw);
  return { workflowRunId, alreadyInFlight: false };
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
          target.organizationId
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
