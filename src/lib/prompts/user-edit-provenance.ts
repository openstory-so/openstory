/**
 * Provenance for a user-edited prompt, resolved at TRIGGER time.
 *
 * The hash records the upstream inputs an edit was authored against, so
 * staleness can later tell "the world moved under this prompt". That makes it a
 * snapshot of what the user was looking at when they hit generate — which only
 * the triggering server fn knows. Deriving it inside the workflow read live DB
 * state instead: a concurrent script edit, or a `step.do` retry re-running the
 * closure later, stamps the edit with inputs it was never written against and
 * staleness then reads fresh forever.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import {
  loadNarrowShotPromptContext,
  type ShotPromptContextSequence,
} from '@/lib/ai/prompt-context';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/shared/observability/logger';
import type { UserEditProvenance } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'prompts', 'user-edit-provenance']);

export async function buildUserEditProvenance(args: {
  kind: 'visual' | 'motion';
  scopedDb: Pick<
    ScopedDb,
    'characters' | 'sequenceLocations' | 'sequenceElements' | 'styles'
  >;
  sequence: ShotPromptContextSequence;
  scene: Scene | null;
  /** Motion only: the i2v anchor still, which participates in its hash (#929). */
  startingFrameImageUrl?: string | null;
}): Promise<UserEditProvenance> {
  const { kind, scopedDb, sequence, scene, startingFrameImageUrl } = args;
  if (!scene) return { inputHash: null, analysisModel: null };
  try {
    const ctx = await loadNarrowShotPromptContext({
      scopedDb,
      sequence,
      scene,
      startingFrameImageUrl,
    });
    return {
      inputHash:
        kind === 'motion'
          ? await computeMotionPromptInputHash(ctx)
          : await computeVisualPromptInputHash(ctx),
      analysisModel: ctx.analysisModel,
    };
  } catch (err) {
    // Recording the edit with a null hash beats losing the edit.
    logger.warn(
      `Could not compute upstream ${kind} hash for user edit on sequence ${sequence.id}; recording with null hash`,
      { err }
    );
    return { inputHash: null, analysisModel: null };
  }
}
