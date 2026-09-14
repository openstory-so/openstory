import {
  charactersToBible,
  sequenceElementsToBible,
  sequenceLocationsToBible,
} from '@/cast/server/bibles-from-scoped';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ValidationError } from '@/platform/errors';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import type {
  MotionPromptHashInput,
  VisualPromptHashInput,
} from '@/shots/input-hash';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/shots/scene-matching';

export type ShotPromptContext = MotionPromptHashInput;

export type ShotPromptContextSequence = {
  id: string;
  styleId: string | null;
  /** Sequence-owned recipe. Preferred over the live catalog row. */
  styleConfig?: unknown;
  aspectRatio: string;
  analysisModel: string;
  /**
   * Reference-only mode. Resolved per shot via `shotPromptSequence(sequence,
   * shot)` (`use-start-frame.ts`) — never the raw sequence column, since
   * `shots.useStartFrame` overrides it — and REQUIRED rather than optional: the failure mode
   * of omitting it is silent and permanent — the stamp would fold the flag in
   * and the verify would not, so every reference-only motion prompt would read
   * stale forever. Making it required turns that into a compile error at each
   * call site instead.
   */
  referenceOnly: boolean;
};

/**
 * The sequence-scoped rows this loader would otherwise read per call. Callers
 * that build contexts for many shots of one sequence load them once and pass
 * them in, turning an O(shots) read pattern into O(1).
 */
export type ShotPromptContextRefs = {
  characters: Awaited<ReturnType<ScopedDb['characters']['listWithSheets']>>;
  locations: Awaited<
    ReturnType<ScopedDb['sequenceLocations']['listWithReferences']>
  >;
  elements: Awaited<ReturnType<ScopedDb['sequenceElements']['list']>>;
  style: Awaited<ReturnType<ScopedDb['styles']['getById']>> | null;
};

export async function loadShotPromptContext(args: {
  scopedDb: Pick<
    ScopedDb,
    'characters' | 'sequenceLocations' | 'sequenceElements' | 'styles'
  >;
  sequence: ShotPromptContextSequence;
  scene: Scene;
  /** Override analysis model — used when a stored variant pins one. */
  analysisModelOverride?: string | null;
  /**
   * URL of the shot's rendered starting image, when this context will feed a
   * motion-prompt hash (#929). Callers pass `shot.thumbnailUrl`.
   */
  startingFrameImageUrl?: string | null;
  /** Pre-loaded sequence rows; when absent they are read here. */
  refs?: ShotPromptContextRefs;
}): Promise<ShotPromptContext> {
  const {
    scopedDb,
    sequence,
    scene,
    analysisModelOverride,
    startingFrameImageUrl,
    refs,
  } = args;

  const hasSnapshot = sequence.styleConfig != null;
  if (!hasSnapshot && !sequence.styleId) {
    // All callers are trigger-side server fns; ValidationError rides the
    // serialization adapter to the client as a typed 400, not a 500.
    throw new ValidationError(
      `Sequence ${sequence.id} has no style selected; prompt context unavailable`
    );
  }

  const [characters, locations, elements, style] = refs
    ? [refs.characters, refs.locations, refs.elements, refs.style]
    : await Promise.all([
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
        scopedDb.sequenceElements.list(sequence.id),
        hasSnapshot || !sequence.styleId
          ? Promise.resolve(null)
          : scopedDb.styles.getById(sequence.styleId),
      ]);

  if (!hasSnapshot && !style) {
    throw new Error(`Style ${sequence.styleId} not found`);
  }

  const analysisModel =
    analysisModelOverride ??
    getAnalysisModelById(sequence.analysisModel)?.id ??
    DEFAULT_ANALYSIS_MODEL;

  return {
    scene,
    styleConfig: resolveSequenceStyleConfig({
      snapshot: sequence.styleConfig,
      live: style?.config,
    }),
    characterBible: charactersToBible(characters),
    locationBible: sequenceLocationsToBible(locations),
    elementBible: sequenceElementsToBible(elements),
    aspectRatio: sequence.aspectRatio,
    analysisModel,
    startingFrameImageUrl: startingFrameImageUrl ?? null,
    referenceOnly: sequence.referenceOnly,
  };
}

/**
 * Same as `loadShotPromptContext` but narrows the character / location /
 * element bibles down to the entries this scene actually references — i.e. the
 * inputs that would actually change the regenerated prompt. Used when stamping
 * or comparing `visualPromptInputHash` / `motionPromptInputHash` so unrelated
 * sequence entities don't poison the hash.
 *
 * Matching mirrors the same logic that decides reference-image attachment at
 * generation time (`scene-matching.ts`), so if the hash flips, regeneration
 * really would see different inputs.
 */
export async function loadNarrowShotPromptContext(args: {
  scopedDb: Pick<
    ScopedDb,
    'characters' | 'sequenceLocations' | 'sequenceElements' | 'styles'
  >;
  sequence: ShotPromptContextSequence;
  scene: Scene;
  analysisModelOverride?: string | null;
  startingFrameImageUrl?: string | null;
  refs?: ShotPromptContextRefs;
}): Promise<ShotPromptContext> {
  const full = await loadShotPromptContext(args);
  return narrowShotPromptContext(full);
}

/**
 * Filter an already-built prompt context down to the entities this scene's
 * `continuity` references. Pure function — exposed so workflows that already
 * received full bibles as inputs (visual/motion prompt scene workflows) can
 * narrow without re-fetching from the DB. Generic so a visual-only bag
 * (no start-frame) narrows without dummy motion channels.
 */
export function narrowShotPromptContext<T extends VisualPromptHashInput>(
  ctx: T
): T {
  const { scene } = ctx;
  const continuity = scene.continuity;
  if (!continuity) return ctx;

  const characterBible = matchCharactersToScene(
    [...ctx.characterBible],
    continuity.characterTags
  );
  const locationBible = matchLocationsToScene(
    [...ctx.locationBible],
    continuity.environmentTag,
    scene.metadata?.location ?? '',
    scene.originalScript.extract
  );
  const elementBible = matchElementsToScene(
    [...ctx.elementBible],
    continuity.elementTags ?? [],
    scene.originalScript.extract
  );

  return { ...ctx, characterBible, locationBible, elementBible };
}
