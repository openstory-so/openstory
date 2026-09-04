/**
 * Snapshot DTO builders + hashers for `regenerateShotsWorkflow`.
 *
 * The workflow opts into the snapshot pattern (see
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md):
 * a per-shot DTO is resolved at trigger time, hashed, and inlined into the
 * QStash payload. Here we own (1) building the per-shot DTO from the live
 * scoped DB and (2) computing the batch hash that gates the start-time
 * tamper check.
 */

import {
  computeShotImageInputHash,
  sha256Hex,
  type ShotImageHashInput,
} from '@/lib/ai/input-hash';
import type { TextToImageModel } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  CharacterWithSheet,
  Shot,
  SequenceElement,
  SequenceLocationWithReference,
} from '@/lib/db/schema';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import type {
  RegenerateShotSnapshot,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import { resolveSceneShotImageReferences } from './sheet-snapshots';

/**
 * Build one shot's snapshot DTO from the live scoped state. Used at trigger
 * time and (with current-state inputs) at write time for divergence checks.
 */
export async function buildRegenerateShotSnapshot(params: {
  shot: Pick<Shot, 'id'>;
  /**
   * The shot's scene, composed from `scenes` + its selected script version
   * (#1067). Callers resolve it via `resolveSceneForShot`; null degrades to the
   * no-references path, as an absent `shot.metadata` did.
   */
  scene: Scene | null;
  /**
   * The frame's current image prompt (mirror of the selected prompt version).
   * Moved off `shots` onto the anchor frame in #989; callers pass
   * `frame.imagePrompt`.
   */
  imagePrompt: string | null;
  /** The prompt version `imagePrompt` came from, when the caller resolved one. */
  imagePromptVersionId?: string | null;
  /** The shot's anchor frame, when the caller already resolved it. */
  frameId?: string;
  characters: CharacterWithSheet[];
  locations: SequenceLocationWithReference[];
  elements: SequenceElement[];
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
}): Promise<RegenerateShotSnapshot> {
  const {
    shot,
    scene,
    imagePrompt,
    imagePromptVersionId,
    frameId,
    characters,
    locations,
    elements,
    imageModel,
    aspectRatio,
  } = params;

  // The visual prompt lives solely on `frame.imagePrompt` (#989/#713) — passed
  // in as `imagePrompt`. The visual-prompt workflow now mirrors AI/regenerated
  // prompts onto it (no more `metadata.prompts.visual` fallback), so this hash
  // tracks the live prompt by construction.
  const effectivePrompt = imagePrompt;

  // Reject empty prompts at the snapshot boundary so trigger-time data
  // errors fail loudly at the call site instead of being absorbed as
  // per-shot failures inside the workflow.
  if (!effectivePrompt || effectivePrompt.length === 0) {
    throw new Error(`Shot ${shot.id} has no visual prompt; cannot snapshot`);
  }

  // Resolve the scene's character / location / element references exactly the
  // way the image-generation trigger snapshot does — same
  // matchers, same reference-hash sets — so this verify-time hash equals the
  // thumbnail hash stamped at generation. Omitting the element/location sets
  // here made every product-/location-bearing shot report stale. See #867.
  const refs = resolveSceneShotImageReferences({
    scene,
    visualPrompt: effectivePrompt,
    characters,
    locations,
    elements,
  });

  const characterRefs = buildCharacterReferenceImages(refs.characters);
  const locationRefs = buildLocationReferenceImages(refs.locations);

  const hashInput: ShotImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: effectivePrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
  };

  const snapshotInputHash = await computeShotImageInputHash(hashInput);

  return {
    shotId: shot.id,
    imagePrompt: effectivePrompt,
    imagePromptVersionId: imagePromptVersionId ?? null,
    frameId: frameId ?? null,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
    characterRefs,
    locationRefs,
    snapshotInputHash,
  };
}

/**
 * Hash the full inlined DTO for the start-time tamper check. Binds every
 * field consumed by the workflow body — including the resolved `characterRefs`
 * and `locationRefs` URLs — so a payload that preserves only `snapshotInputHash`
 * cannot smuggle replaced reference images past validation.
 */
export async function computeRegenerateShotsBatchHash(
  input: Pick<
    RegenerateShotsWorkflowInput,
    'aspectRatio' | 'imageModel' | 'shotSnapshots' | 'sequenceId'
  >
): Promise<string> {
  return sha256Hex({
    artifact: 'regenerate-shots:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    aspectRatio: input.aspectRatio,
    shots: [...input.shotSnapshots].sort((a, b) =>
      a.shotId < b.shotId ? -1 : 1
    ),
  });
}

type RecastEventPayload =
  | { event: 'start'; triggerId: string; shotCount: number }
  | {
      event: 'complete';
      triggerId: string;
      successCount: number;
      failedCount: number;
    }
  | { event: 'failed'; triggerId: string; error: string };

/**
 * Emit a recast lifecycle event on the channel that matches the triggering
 * entity. Character recasts go to `recast:*` (keyed by characterId);
 * location recasts go to `recast-location:*` (keyed by locationId). The
 * workflow body does not know which channel to use without this helper —
 * `triggeringCharacterId` was the original (incorrect) overload.
 */
export async function emitRecastEvent(
  args: {
    kind: 'character' | 'location';
    sequenceId: string;
  } & RecastEventPayload
): Promise<void> {
  const channel = getGenerationChannel(args.sequenceId);
  if (args.kind === 'character') {
    if (args.event === 'start') {
      await channel.emit('generation.recast:start', {
        characterId: args.triggerId,
        shotCount: args.shotCount,
      });
      return;
    }
    if (args.event === 'complete') {
      await channel.emit('generation.recast:complete', {
        characterId: args.triggerId,
        successCount: args.successCount,
        failedCount: args.failedCount,
      });
      return;
    }
    await channel.emit('generation.recast:failed', {
      characterId: args.triggerId,
      error: args.error,
    });
    return;
  }
  if (args.event === 'start') {
    await channel.emit('generation.recast-location:start', {
      locationId: args.triggerId,
      shotCount: args.shotCount,
    });
    return;
  }
  if (args.event === 'complete') {
    await channel.emit('generation.recast-location:complete', {
      locationId: args.triggerId,
      successCount: args.successCount,
      failedCount: args.failedCount,
    });
    return;
  }
  await channel.emit('generation.recast-location:failed', {
    locationId: args.triggerId,
    error: args.error,
  });
}
