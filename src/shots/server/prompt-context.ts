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
  resolveShotReferences,
  type ShotPromptView,
} from '@/shots/scene-matching';

/**
 * Everything a prompt hash reads except the shot's lines, which the motion
 * hash takes separately (`dialogue`, #1784) — the caller resolves them.
 */
export type ShotPromptContext = Omit<MotionPromptHashInput, 'dialogue'>;

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
  characters: Awaited<ReturnType<ScopedDb['characters']['list']>>;
  locations: Awaited<ReturnType<ScopedDb['sequenceLocations']['list']>>;
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
        scopedDb.characters.list(sequence.id),
        scopedDb.sequenceLocations.list(sequence.id),
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
 * `loadShotPromptContext` narrowed to what one prompt of the shot references
 * (`shot`), plus the same inputs narrowed by the scene roster
 * (`sceneRoster`). Only `shot` is stamped. `sceneRoster` is what every digest
 * written before #2012 hashed; verify accepts it so those rows stay fresh
 * until an input moves. Delete it with `LEGACY_HASH_UNTIL`.
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
  view: ShotPromptView;
}): Promise<{ shot: ShotPromptContext; sceneRoster: ShotPromptContext }> {
  const { view, ...rest } = args;
  const full = await loadShotPromptContext(rest);
  return {
    shot: narrowShotPromptContext(full, view),
    sceneRoster: narrowShotPromptContext(full, { ...view, prompt: null }),
  };
}

/**
 * Narrow a prompt context's bibles to what this prompt of the shot references
 * (#2012, `resolveShotReferences`). Pure, so workflows that received full
 * bibles on their payload narrow without a read. Generic so a visual-only bag
 * (no start-frame) narrows without dummy motion channels.
 *
 * The view is required: the hash of a prompt stamped against the wrong set
 * reads stale (or fresh) forever, and the compiler is the only thing that
 * tells a stamp site from a verify site.
 */
export function narrowShotPromptContext<T extends VisualPromptHashInput>(
  ctx: T,
  view: ShotPromptView
): T {
  const { scene } = ctx;
  const continuity = scene.continuity;
  const resolved = resolveShotReferences(
    {
      characters: [...ctx.characterBible],
      locations: [...ctx.locationBible],
      elements: [...ctx.elementBible],
    },
    {
      characterTags: continuity?.characterTags,
      environmentTag: continuity?.environmentTag,
      sceneLocation: scene.metadata?.location,
      elementTags: continuity?.elementTags,
      sceneExtract: scene.originalScript.extract,
    },
    view
  );
  return {
    ...ctx,
    characterBible: resolved.characters,
    locationBible: resolved.locations,
    elementBible: resolved.elements,
  };
}
