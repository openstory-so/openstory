/**
 * The recast snapshots are built at the trigger, before the sheet the awaited
 * child will generate exists — so the subject's sheet enters as a sentinel and
 * the workflow substitutes the real one in memory.
 *
 * The invariant that matters: a merged snapshot must be byte-identical to the
 * snapshot the trigger WOULD have built had the sheet already existed. If it
 * isn't, the regenerated image is stamped with a hash nothing can reproduce
 * and every shot reports permanently stale.
 */

import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type {
  CharacterWithSheet,
  SequenceElement,
  SequenceLocationWithReference,
  Shot,
} from '@/lib/db/schema';
import { buildRegenerateShotSnapshot } from './regenerate-shots-snapshot';
import {
  mergeRecastSheetIntoSnapshots,
  PENDING_SHEET_HASH,
  PENDING_SHEET_URL,
} from './recast-snapshot';

const NOW = new Date('2026-08-07T00:00:00Z');
const PROMPT = 'Jack at the docks at dusk';
const NEW_SHEET_URL = 'https://example.com/jack-recast.png';
const NEW_SHEET_HASH = 'jack-hash-v2';

function makeCharacter(
  overrides: Partial<CharacterWithSheet> = {}
): CharacterWithSheet {
  const character: CharacterWithSheet = {
    id: 'c1',
    sequenceId: 'seq1',
    characterId: 'jack',
    name: 'Jack',
    age: '30s',
    gender: null,
    ethnicity: null,
    physicalDescription: null,
    standardClothing: null,
    distinguishingFeatures: null,
    consistencyTag: 'jack-the-pi',
    sheetImageUrl: 'https://example.com/jack-old.png',
    sheetImagePath: null,
    sheetStatus: 'completed',
    sheetGeneratedAt: NOW,
    sheetError: null,
    sheetInputHash: 'jack-hash-v1',
    selectedSheetVersionId: null,
    talentId: null,
    firstMentionLine: null,
    firstMentionText: null,
    firstMentionSceneId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...character, ...overrides };
}

function makeLocation(
  overrides: Partial<SequenceLocationWithReference> = {}
): SequenceLocationWithReference {
  const location: SequenceLocationWithReference = {
    id: 'l1',
    sequenceId: 'seq1',
    locationId: 'docks',
    libraryLocationId: null,
    name: 'The Docks',
    type: 'exterior',
    timeOfDay: 'dusk',
    description: 'A weathered pier',
    architecturalStyle: null,
    keyFeatures: null,
    colorPalette: null,
    lightingSetup: null,
    ambiance: null,
    consistencyTag: 'the-docks',
    referenceImageUrl: 'https://example.com/docks-old.png',
    referenceImagePath: null,
    referenceStatus: 'completed',
    referenceGeneratedAt: NOW,
    referenceError: null,
    referenceInputHash: 'docks-hash-v1',
    selectedReferenceVersionId: null,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...location, ...overrides };
}

const SHOT: Shot = {
  id: 'shot1',
  sequenceId: 'seq1',
  sceneId: 's1',
  shotNumber: 1,
  durationMs: 3000,
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const SCENE: Scene = {
  sceneId: 's1',
  sceneNumber: 1,
  originalScript: { extract: '', dialogue: [] },
  continuity: {
    characterTags: ['jack-the-pi'],
    environmentTag: 'the-docks',
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
};

const NO_ELEMENTS: SequenceElement[] = [];

const BUILD_DEFAULTS = {
  shot: SHOT,
  scene: SCENE,
  imagePrompt: PROMPT,
  elements: NO_ELEMENTS,
  imageModel: 'nano_banana_2' as const,
  aspectRatio: '16:9' as const,
};

const MERGE_DEFAULTS = {
  sequenceId: 'seq1',
  imageModel: 'nano_banana_2' as const,
  aspectRatio: '16:9' as const,
};

describe('mergeRecastSheetIntoSnapshots', () => {
  it('reproduces the snapshot the trigger would have built with the new character sheet', async () => {
    const pending = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [
        makeCharacter({
          sheetImageUrl: PENDING_SHEET_URL,
          sheetInputHash: PENDING_SHEET_HASH,
        }),
      ],
      locations: [makeLocation()],
    });
    const expected = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [
        makeCharacter({
          sheetImageUrl: NEW_SHEET_URL,
          sheetInputHash: NEW_SHEET_HASH,
        }),
      ],
      locations: [makeLocation()],
    });

    const merged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: [pending],
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: NEW_SHEET_HASH,
    });

    expect(merged.shotSnapshots).toEqual([expected]);
  });

  it('reproduces the snapshot the trigger would have built with the new location reference', async () => {
    const pending = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [makeCharacter()],
      locations: [
        makeLocation({
          referenceImageUrl: PENDING_SHEET_URL,
          referenceInputHash: PENDING_SHEET_HASH,
        }),
      ],
    });
    const expected = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [makeCharacter()],
      locations: [
        makeLocation({
          referenceImageUrl: NEW_SHEET_URL,
          referenceInputHash: NEW_SHEET_HASH,
        }),
      ],
    });

    const merged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: [pending],
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: NEW_SHEET_HASH,
    });

    expect(merged.shotSnapshots).toEqual([expected]);
  });

  it('leaves a snapshot that never referenced the recast subject untouched', async () => {
    const untouched = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [makeCharacter()],
      locations: [makeLocation()],
    });

    const merged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: [untouched],
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: NEW_SHEET_HASH,
    });

    expect(merged.shotSnapshots).toEqual([untouched]);
  });

  it('drops the sentinel hash when the sheet was written without one', async () => {
    const pending = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [
        makeCharacter({
          sheetImageUrl: PENDING_SHEET_URL,
          sheetInputHash: PENDING_SHEET_HASH,
        }),
      ],
      locations: [makeLocation()],
    });
    const expected = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [
        makeCharacter({
          sheetImageUrl: NEW_SHEET_URL,
          sheetInputHash: null,
        }),
      ],
      locations: [makeLocation()],
    });

    const merged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: [pending],
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: null,
    });

    expect(merged.shotSnapshots).toEqual([expected]);
  });

  it('rehashes the batch so the regenerate child validates the merged payload', async () => {
    const pending = await buildRegenerateShotSnapshot({
      ...BUILD_DEFAULTS,
      characters: [
        makeCharacter({
          sheetImageUrl: PENDING_SHEET_URL,
          sheetInputHash: PENDING_SHEET_HASH,
        }),
      ],
      locations: [makeLocation()],
    });

    const merged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: [pending],
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: NEW_SHEET_HASH,
    });
    const remerged = await mergeRecastSheetIntoSnapshots({
      ...MERGE_DEFAULTS,
      shotSnapshots: merged.shotSnapshots,
      sheetImageUrl: NEW_SHEET_URL,
      sheetInputHash: NEW_SHEET_HASH,
    });

    // Idempotent: re-running the merge over already-merged snapshots is a
    // no-op, so a step replay cannot double-substitute.
    expect(remerged.snapshotInputHash).toBe(merged.snapshotInputHash);
    expect(merged.snapshotInputHash).not.toBe(PENDING_SHEET_HASH);
  });
});
