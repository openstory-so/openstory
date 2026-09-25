/**
 * Behavioural tests for the per-shot image-workflow hash helper.
 *
 * `generateImageWorkflow` opts into the snapshot pattern so it can verify at
 * start that the inlined DTO matches the hash it was triggered with. These
 * tests pin that `computeImageWorkflowHashFromDto` is deterministic and moves
 * with every bound input (model, character sheet).
 *
 * The convergent/divergent WRITE builders and the `persistImageResult`
 * orchestration were retired in #989: image divergence no longer reverts a
 * speculative primary thumbnail on `shots`/`shot_variants`. Image generation
 * now appends a `frame_variants` version and repoints
 * `frames.selectedImageVersionId`, so only the DTO hasher remains — the live
 * re-resolve (`computeImageWorkflowHashCurrent`) had no callers left and is
 * gone.
 */

import { describe, expect, it } from 'vitest';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/platform/server/workflow/types';
import { computeImageWorkflowHashFromDto } from './image-workflow-snapshot';

const baseScene: ShotImageSceneSnapshot = {
  sceneId: 's1',
  visualPrompt: 'A wide establishing shot of Jack at the docks at dusk',
  characterSheetHashes: ['jack-hash-v1'],
  locationSheetHashes: ['docks-hash-v1'],
  elementReferenceHashes: [],
  elementTokens: [],
};

const baseInput: ImageWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq1',
  shotId: 'f1',
  prompt: baseScene.visualPrompt,
  model: 'nano_banana_2',
  aspectRatio: '16:9',
  sceneSnapshot: baseScene,
};

describe('computeImageWorkflowHashFromDto', () => {
  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: undefined,
      snapshotInputHash: undefined,
    });
    expect(result).toBe('');
  });

  it('produces a deterministic hash for identical snapshots', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto(baseInput);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes the hash when the model changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      model: 'seedream_v5',
    });
    expect(a).not.toBe(b);
  });

  it('changes the hash when a character sheet hash changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        characterSheetHashes: ['jack-hash-v2'],
      },
    });
    expect(a).not.toBe(b);
  });
});

describe('computeImageWorkflowHashFromDto — aspectRatio guard', () => {
  it('throws when sceneSnapshot is present but aspectRatio is missing', () => {
    expect(() =>
      computeImageWorkflowHashFromDto({
        ...baseInput,
        aspectRatio: undefined,
      })
    ).toThrow(/aspectRatio is required/);
  });
});

// The `buildImageConvergentWrites`, `buildImageDivergentWrites`, and
// `persistImageResult` describe blocks were removed in #989: image divergence
// is retired (no speculative primary thumbnail on `shots`/`shot_variants` to
// revert), so those helpers no longer exist. Image selection now happens via
// `frameVariants.select` — covered by `frame-variants.test.ts`.
