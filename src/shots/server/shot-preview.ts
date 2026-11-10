/**
 * A shot's storyboard sketch: the grey animatic on the scene rail (#1101,
 * #1642). Scene split draws one per shot; after that every spec version is
 * drawn, start-frame shots included, and the sketch records the version it
 * was drawn from (#2350). See `docs/architecture/reference-only-motion.md`.
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
import type {
  FrameVariant,
  ShotSpecVersion,
} from '@/platform/server/db/schema';
import type { EnforcementRow } from '@/platform/server/compliance/enforcement';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { ImageWorkflowInput } from '@/platform/server/workflow/types';
import {
  buildPreviewPrompt,
  previewTextForShot,
} from '@/sequences/server/poster-prompt';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
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
  /** The spec version drawn; null for scene split and a shot with no spec. */
  specVersionId: string | null;
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
      specVersionId: target.specVersionId,
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

type SketchScene = {
  originalScript?: { extract?: string } | null;
  metadata?: { title?: string } | null;
} | null;

/** The sketch prompt for one spec, the same text scene split draws from. */
function specSketchPrompt(
  spec: StoredShotSpec,
  scene: SketchScene,
  cast: readonly CharacterBibleEntry[]
): string {
  const text = previewTextForShot(
    {
      shots: [{ ...spec, shotNumber: 1 }],
      originalScript: { extract: scene?.originalScript?.extract ?? '' },
      metadata: {
        title: scene?.metadata?.title ?? '',
        location: '',
        timeOfDay: '',
      },
    },
    1
  );
  return buildPreviewPrompt(text, cast);
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

async function startPreview(
  context: PreviewContext,
  prompt: string,
  specVersionId: string | null,
  deduplicationId?: string
) {
  const { scopedDb, user, organizationId, shot, frame, sequence } = context;
  await requireCredits(scopedDb, await previewCostMicros(sequence.aspectRatio));
  return triggerShotPreview(
    {
      userId: user.id,
      organizationId,
      sequenceId: sequence.id,
      shotId: shot.id,
      frameId: frame.id,
      aspectRatio: sequence.aspectRatio,
      prompt,
      specVersionId,
    },
    deduplicationId ? { deduplicationId } : undefined
  );
}

const isLive = (row: FrameVariant) =>
  row.status === 'generating' || row.status === 'pending';

/**
 * Draw a sketch for a spec version the user just saved or picked. Skipped
 * when that version already has a sketch from the same prompt. Never throws:
 * the spec is already saved, and a failure here must not report it as failed.
 */
export async function drawSpecSketch(
  context: PreviewContext,
  version: Pick<ShotSpecVersion, 'id' | 'spec'>
): Promise<void> {
  const { scopedDb, shot, frame, scene } = context;
  try {
    const prompt = specSketchPrompt(
      version.spec,
      scene,
      await previewCast(context)
    );
    const hash = simpleHash(prompt);
    const rows = await scopedDb.frameVariants.listPreviews(frame.id);
    const drawn = rows.some(
      (row) =>
        row.specVersionId === version.id &&
        row.promptHash === hash &&
        (row.status === 'completed' || isLive(row))
    );
    if (drawn) return;
    await startPreview(context, prompt, version.id);
  } catch (error) {
    logger.warn(
      `Sketch for shot ${shot.id} spec ${version.id} did not start; its old sketch stays up`,
      { err: error }
    );
  }
}

// ponytail: scene split draws before the analysis spec exists, so its sketch
// carries no id. Read it as the nearest analysis version within ten minutes.
const ATTRIBUTE_WINDOW_MS = 10 * 60 * 1000;

/** The spec version each sketch was drawn from, by id or by that rule. */
function sketchSpecIds(
  rows: readonly FrameVariant[],
  versions: readonly ShotSpecVersion[]
): Map<string, string | null> {
  const analyses = versions.filter((v) => v.source === 'analysis');
  return new Map(
    rows.map((row) => {
      if (row.specVersionId) return [row.id, row.specVersionId];
      let best: ShotSpecVersion | null = null;
      let bestGap = ATTRIBUTE_WINDOW_MS;
      for (const v of analyses) {
        const gap = Math.abs(v.createdAt.getTime() - row.createdAt.getTime());
        if (gap <= bestGap) {
          best = v;
          bestGap = gap;
        }
      }
      return [row.id, best?.id ?? null];
    })
  );
}

type StoryboardStaleReason = 'missing' | 'failed' | 'changed';

/**
 * A shot's storyboard (#2350): the sketch on show, whether it is stale and
 * why, every sketch drawn for it, and every spec version with its sketch,
 * newest first. The selected spec's newest sketch shows; until it lands the
 * newest sketch of any version shows, stale.
 */
export async function readShotStoryboard(context: PreviewContext) {
  const { scopedDb, shot, frame, sequence, scene } = context;
  const [rows, versions, cast, motion] = await Promise.all([
    scopedDb.frameVariants.listPreviews(frame.id),
    scopedDb.shotSpecVersions.listByShot(shot.id),
    previewCast(context),
    scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
  ]);
  const specOf = sketchSpecIds(rows, versions);
  const selected =
    versions.find((v) => v.id === shot.selectedSpecVersionId) ?? null;
  const done = (row: FrameVariant) => row.status === 'completed' && !!row.url;

  // A shot with no spec (from before #1915) is drawn from its motion prompt.
  const fresh = selected
    ? simpleHash(specSketchPrompt(selected.spec, scene, cast))
    : motion?.text
      ? simpleHash(buildPreviewPrompt(motion.text, cast))
      : null;
  const mine = selected
    ? rows.filter((row) => specOf.get(row.id) === selected.id)
    : rows;
  const current = mine.find(done) ?? rows.find(done) ?? null;
  const generating = rows[0] ? isLive(rows[0]) : false;
  // Only a stamped sketch is held to its prompt: scene split's used an
  // earlier cast label, so its hash never matches.
  const promptMoved =
    !!current &&
    (!selected || current.specVersionId === selected.id) &&
    current.promptHash !== fresh;
  const staleReason: StoryboardStaleReason | null = generating
    ? null
    : !current
      ? 'missing'
      : mine[0]?.status === 'failed'
        ? 'failed'
        : (selected && specOf.get(current.id) !== selected.id) || promptMoved
          ? 'changed'
          : null;

  const sketch = (row: FrameVariant) => ({
    id: row.id,
    url: row.url,
    status: row.status,
    error: row.status === 'failed' ? row.error : null,
    model: row.model,
    specVersionId: specOf.get(row.id) ?? null,
    createdAt: row.createdAt,
  });
  return {
    shotId: shot.id,
    referenceOnly: rendersReferenceOnly(shot, sequence),
    generating,
    staleReason,
    current: current && sketch(current),
    history: rows.map(sketch),
    versions: versions.map((version) => {
      const drawn = rows.find((row) => specOf.get(row.id) === version.id);
      return {
        id: version.id,
        source: version.source,
        spec: version.spec,
        createdAt: version.createdAt,
        selected: version.id === selected?.id,
        sketch: drawn ? sketch(drawn) : null,
      };
    }),
  };
}

/**
 * Draw the shot's sketch again now, from its selected spec. Unlike the
 * automatic draw, a failure to start throws.
 */
export async function regenerateShotStoryboard(context: PreviewContext) {
  const { scopedDb, shot, frame, scene } = context;
  const newest = (await scopedDb.frameVariants.listPreviews(frame.id, 1))[0];
  if (newest && isLive(newest)) {
    return { workflowRunId: newest.workflowRunId, alreadyInFlight: true };
  }
  const [spec, motion, cast] = await Promise.all([
    scopedDb.shotSpecVersions.getSelected(shot.id),
    scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
    previewCast(context),
  ]);
  const prompt = spec
    ? specSketchPrompt(spec.spec, scene, cast)
    : motion?.text
      ? buildPreviewPrompt(motion.text, cast)
      : null;
  if (!prompt)
    throw new ValidationError('Shot has nothing to draw a sketch from');
  // Two clicks that saw the same newest sketch start one run, not two.
  const workflowRunId = await startPreview(
    context,
    prompt,
    spec?.id ?? null,
    `storyboard-${frame.id}-${newest?.id ?? 'none'}`
  );
  return { workflowRunId, alreadyInFlight: false };
}

/**
 * The same draw from inside a run (Rewrite shot), for the spec it just
 * promoted. `deduplicationId` keeps a replayed step from drawing twice.
 */
export async function drawSpecSketchInRun(
  scopedDb: WorkflowScopedDb,
  target: Omit<PreviewTarget, 'prompt' | 'specVersionId'> & {
    version: Pick<ShotSpecVersion, 'id' | 'spec'>;
    scene: SketchScene;
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
        prompt: specSketchPrompt(
          target.version.spec,
          target.scene,
          target.characterBible
        ),
        specVersionId: target.version.id,
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
      `Sketch for shot ${target.shotId} did not start; its old sketch stays up`,
      { err: error }
    );
  }
}
