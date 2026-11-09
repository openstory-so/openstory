/**
 * Snapshot DTO hasher for the image workflow.
 *
 * `computeFromDto` hashes the inlined per-scene snapshot for the start-time
 * tamper check. In #989 a drift no longer routes to a divergent `shot_variants`
 * row — the image workflow simply appends the new `frame_variants` version
 * without repointing `frames.selectedImageVersionId` (the retained-but-
 * unselected version is the "divergence"), so the trigger-time hash is the
 * only one the run ever computes.
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type { ImageWorkflowInput } from '@/platform/server/workflow/types';
import { stampShotImageScene } from '@/cast/server/workflows/sheet-snapshots';
import type { ShotImageInputHash, Stamped } from '@/shots/input-hash';

const NO_SNAPSHOT_SENTINEL = '';

function requireAspectRatio(
  input: ImageWorkflowInput
): NonNullable<ImageWorkflowInput['aspectRatio']> {
  if (!input.aspectRatio) {
    throw new WorkflowValidationError(
      'aspectRatio is required when sceneSnapshot is present; trigger-time and write-time hashes would otherwise diverge'
    );
  }
  return input.aspectRatio;
}

export function computeImageWorkflowHashFromDto(
  input: ImageWorkflowInput
): Promise<string> | string {
  const { sceneSnapshot } = input;
  if (!sceneSnapshot) {
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;
  }
  return stampImageWorkflowSnapshot({ ...input, sceneSnapshot }).then(
    (stamp) => stamp.hash
  );
}

/** The still stamp of a payload that carries a scene snapshot. */
export function stampImageWorkflowSnapshot(
  input: ImageWorkflowInput & {
    sceneSnapshot: NonNullable<ImageWorkflowInput['sceneSnapshot']>;
  }
): Promise<Stamped<ShotImageInputHash>> {
  return stampShotImageScene(
    input.sceneSnapshot,
    input.model ?? DEFAULT_IMAGE_MODEL,
    requireAspectRatio(input)
  );
}
