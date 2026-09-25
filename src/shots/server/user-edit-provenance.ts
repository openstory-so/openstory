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

import type { MotionDialogue, Scene } from '@/shots/scene-analysis.schema';
import {
  hashMotionPromptInput,
  hashVisualPromptInput,
} from '@/shots/input-hash';
import {
  loadNarrowShotPromptContext,
  type ShotPromptContextSequence,
} from './prompt-context';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import type { UserEditProvenance } from '@/platform/server/workflow/types';

const logger = getLogger(['openstory', 'prompts', 'user-edit-provenance']);

export async function buildUserEditProvenance(
  args: {
    scopedDb: Pick<
      ScopedDb,
      'characters' | 'sequenceLocations' | 'sequenceElements' | 'styles'
    >;
    sequence: ShotPromptContextSequence;
    scene: Scene | null;
  } & (
    | { kind: 'visual' }
    | {
        kind: 'motion';
        /** The i2v anchor still, which participates in its hash (#929). */
        startingFrameImageUrl: string | null;
        /** What the shot says (#1784) — the lines the edit was written against. */
        dialogue: MotionDialogue;
      }
  )
): Promise<UserEditProvenance> {
  const { scopedDb, sequence, scene } = args;
  if (!scene) return { inputHash: null, analysisModel: null };
  try {
    const ctx = await loadNarrowShotPromptContext({
      scopedDb,
      sequence,
      scene,
      startingFrameImageUrl:
        args.kind === 'motion' ? args.startingFrameImageUrl : undefined,
    });
    return {
      inputHash:
        args.kind === 'motion'
          ? await hashMotionPromptInput({ ...ctx, dialogue: args.dialogue })
          : await hashVisualPromptInput(ctx),
      analysisModel: ctx.analysisModel,
    };
  } catch (err) {
    // Recording the edit with a null hash beats losing the edit.
    logger.warn(
      `Could not compute upstream ${args.kind} hash for user edit on sequence ${sequence.id}; recording with null hash`,
      { err }
    );
    return { inputHash: null, analysisModel: null };
  }
}
