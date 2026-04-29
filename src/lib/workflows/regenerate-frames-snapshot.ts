/**
 * Snapshot DTO builders + hashers for `regenerateFramesWorkflow`.
 *
 * The workflow opts into the snapshot pattern (see
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md):
 * a per-frame DTO is resolved at trigger time, hashed, and inlined into the
 * QStash payload. Here we own (1) building the per-frame DTO from the live
 * scoped DB and (2) computing the batch hash that gates the start-time
 * tamper check.
 */

import {
  computeFrameImageInputHash,
  sha256Hex,
  type FrameImageHashInput,
} from '@/lib/ai/input-hash';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Character, Frame, SequenceLocation } from '@/lib/db/schema';
import { matchLocationsToFrame } from '@/lib/db/scoped/sequence-locations';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type {
  RegenerateFrameSnapshot,
  RegenerateFramesWorkflowInput,
} from '@/lib/workflow/types';

/**
 * Match a character to a frame by continuity tag. Inlined here (rather than
 * imported from the workflow) so trigger-time and write-time both see the
 * same matching rules.
 */
export function matchCharactersToFrame(
  allCharacters: Character[],
  characterTags: string[]
): Character[] {
  if (characterTags.length === 0) return [];
  return allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();
    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        (consistencyTag && consistencyTag.includes(tagLower)) ||
        tagLower.includes(charName) ||
        (charName.includes(tagLower) && tagLower.length >= 3) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });
}

/** Drop nulls and sort so order-insensitive comparisons match. */
function collectSortedHashes(
  hashes: Array<string | null | undefined>
): string[] {
  return hashes
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .sort();
}

/**
 * Build one frame's snapshot DTO from the live scoped state. Used at trigger
 * time and (with current-state inputs) at write time for divergence checks.
 */
export async function buildRegenerateFrameSnapshot(params: {
  frame: Pick<Frame, 'id' | 'imagePrompt' | 'metadata'>;
  characters: Character[];
  locations: SequenceLocation[];
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
}): Promise<RegenerateFrameSnapshot> {
  const { frame, characters, locations, imageModel, aspectRatio } = params;
  const characterTags = frame.metadata?.continuity?.characterTags ?? [];
  const frameCharacters = matchCharactersToFrame(characters, characterTags);
  const frameLocations = matchLocationsToFrame(frame, locations);

  const characterSheetHashes = collectSortedHashes(
    frameCharacters.map((c) => c.sheetInputHash)
  );
  // `sequence_locations` does not yet carry its own input_hash column (Stage 1
  // put hashes on `location_sheets` and `locationLibrary`). For now we skip
  // them — character-recast divergence is the headline case this PR proves
  // out, and sequence-location hashes drop in here without other changes
  // when that column lands.
  const locationSheetHashes: string[] = [];

  const characterRefs = buildCharacterReferenceImages(frameCharacters);
  const locationRefs = buildLocationReferenceImages(frameLocations);

  const hashInput: FrameImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: frame.imagePrompt ?? '',
    imageModel,
    aspectRatio,
    characterSheetHashes,
    locationSheetHashes,
    elementReferenceHashes: [],
  };

  const snapshotInputHash = await computeFrameImageInputHash(hashInput);

  return {
    frameId: frame.id,
    imagePrompt: frame.imagePrompt ?? '',
    characterSheetHashes,
    locationSheetHashes,
    characterRefs,
    locationRefs,
    snapshotInputHash,
  };
}

/**
 * Hash the full DTO for the start-time tamper check. We hash the per-frame
 * `snapshotInputHash` values plus the workflow-level fields — that way two
 * payloads agree iff every frame agrees.
 */
export async function computeRegenerateFramesBatchHash(
  input: Pick<
    RegenerateFramesWorkflowInput,
    'aspectRatio' | 'imageModel' | 'frameSnapshots' | 'sequenceId'
  >
): Promise<string> {
  return sha256Hex({
    artifact: 'regenerate-frames:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    aspectRatio: input.aspectRatio,
    frames: [...input.frameSnapshots]
      .map((f) => ({ frameId: f.frameId, hash: f.snapshotInputHash }))
      .sort((a, b) => (a.frameId < b.frameId ? -1 : 1)),
  });
}
