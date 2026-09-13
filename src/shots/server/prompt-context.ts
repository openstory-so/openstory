import {
  charactersToBible,
  sequenceElementsToBible,
  sequenceLocationsToBible,
} from '@/cast/server/bibles-from-scoped';
import { dialogueVoicesForHash } from '@/motion/dialogue-tts';
import type { DialogueVoiceHashInput } from '@/motion/dialogue-tts';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/shots/scene-analysis.schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ValidationError } from '@/platform/errors';
import type { StyleConfig } from '@/platform/server/db/schema';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/shots/scene-matching';

export type ShotPromptContext = {
  scene: Scene;
  styleConfig: StyleConfig;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
  aspectRatio: string;
  analysisModel: string;
  /**
   * URL of the rendered starting-shot image (`shots.thumbnailUrl`), when
   * known. Only the motion-prompt hash consumes it (#929); pass it at sites
   * that stamp or verify `motionPromptInputHash` so a re-rendered image
   * re-stales the motion prompt. Left undefined for visual-only sites.
   */
  startingFrameImageUrl?: string | null;
  /**
   * Reference-only mode. Only the motion-prompt hash consumes it: the mode
   * selects a different LLM template, so the same scene produces a different
   * prompt under it and a mode flip must re-stale what is stored.
   */
  referenceOnly?: boolean;
  /**
   * Dialogue TTS (#1554). Only the motion-prompt hash consumes it, and only
   * when a speaker has a designed voice. Loaded from every character row
   * (including voice-only narrators that `listWithSheets` drops).
   */
  dialogueVoices?: DialogueVoiceHashInput[];
};

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
  /**
   * Every character on the sequence, including voice-only narrators that
   * `listWithSheets` drops. The motion-prompt hash matches speakers against
   * these. When absent, `loadShotPromptContext` reads `characters.list`.
   */
  voiceCharacters?: Awaited<ReturnType<ScopedDb['characters']['list']>>;
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

  const [characters, locations, elements, style, voiceCharacters] = refs
    ? [
        refs.characters,
        refs.locations,
        refs.elements,
        refs.style,
        refs.voiceCharacters ?? refs.characters,
      ]
    : await Promise.all([
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
        scopedDb.sequenceElements.list(sequence.id),
        hasSnapshot || !sequence.styleId
          ? Promise.resolve(null)
          : scopedDb.styles.getById(sequence.styleId),
        scopedDb.characters.list(sequence.id),
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
    startingFrameImageUrl,
    referenceOnly: sequence.referenceOnly,
    dialogueVoices: dialogueVoicesForHash(
      {
        presence: scene.originalScript.dialogue.length > 0,
        lines: scene.originalScript.dialogue,
      },
      voiceCharacters
    ),
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
 * Filter an already-built `ShotPromptContext` down to the entities this
 * scene's `continuity` references. Pure function — exposed so workflows that
 * already received full bibles as inputs (visual/motion prompt scene workflows)
 * can narrow without re-fetching from the DB.
 */
export function narrowShotPromptContext(
  ctx: ShotPromptContext
): ShotPromptContext {
  const { scene } = ctx;
  const continuity = scene.continuity;
  if (!continuity) return ctx;

  const characterBible = matchCharactersToScene(
    ctx.characterBible,
    continuity.characterTags
  );
  const locationBible = matchLocationsToScene(
    ctx.locationBible,
    continuity.environmentTag,
    scene.metadata?.location ?? '',
    scene.originalScript.extract
  );
  const elementBible = matchElementsToScene(
    ctx.elementBible,
    continuity.elementTags ?? [],
    scene.originalScript.extract
  );

  return { ...ctx, characterBible, locationBible, elementBible };
}
