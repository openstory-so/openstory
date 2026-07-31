/**
 * Per-shot staleness computation (#1077) — shared by the `getShotStaleness*`
 * server fns and `UpdateStaleShotsWorkflow` (#1085). Each value is computed by
 * re-deriving the current input hash from live scoped state and comparing it
 * to the stored `*_input_hash`.
 */

import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import {
  loadNarrowShotPromptContext,
  type ShotPromptContextSequence,
} from '@/lib/ai/prompt-context';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Frame, Shot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'shots', 'staleness']);

/**
 * Per-artifact staleness. Shared vocabulary — the client re-exports this type
 * rather than redeclaring it, so the two can't drift.
 */
export type ArtifactStaleness = 'stale' | 'fresh' | 'untracked' | 'unknown';

export type ShotStalenessResult = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
};

/** Every artifact unopinionated — the missing-anchor and no-scene cases. */
export const UNTRACKED_STALENESS: ShotStalenessResult = {
  thumbnail: 'untracked',
  visualPrompt: 'untracked',
  motionPrompt: 'untracked',
};

export type ShotStalenessRefs = {
  characters: Awaited<ReturnType<ScopedDb['characters']['listWithSheets']>>;
  locations: Awaited<
    ReturnType<ScopedDb['sequenceLocations']['listWithReferences']>
  >;
  elements: Awaited<ReturnType<ScopedDb['sequenceElements']['list']>>;
};

/**
 * Four states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 *   - `'unknown'`   — the comparison itself failed (style deleted mid-flight,
 *                     transient D1 read, malformed row). Distinct from
 *                     `'untracked'`: read paths render both as "no opinion",
 *                     but a WRITE path must not treat "we couldn't tell" as
 *                     "nothing to do" — `computePlan` reports these as skipped
 *                     rather than silently dropping a possibly-stale artifact
 *                     and then claiming the run succeeded.
 *
 * `refs` lets batched callers load the character / location / element lists
 * once for the whole scene/sequence instead of once per shot; when absent
 * they are loaded lazily (only the thumbnail branch needs them).
 */
export async function computeShotStaleness(args: {
  scopedDb: ScopedDb;
  sequence: ShotPromptContextSequence & { aspectRatio: AspectRatio };
  shot: Shot;
  frame: Frame;
  scene: Scene | null;
  refs?: ShotStalenessRefs;
}): Promise<ShotStalenessResult> {
  const { scopedDb, sequence, shot, frame, scene, refs } = args;
  const shotForHash = scene ? { ...shot, metadata: scene } : shot;

  let thumbnail: ArtifactStaleness = 'untracked';
  // The visual prompt lives solely on the anchor frame's `imagePrompt` mirror
  // now (#989/#713): the visual-prompt workflow writes a `frame_prompt_versions`
  // row that mirrors onto `frame.imagePrompt`, so AI-generated and regenerated
  // shots both populate it — the old `metadata.prompts.visual` fallback is gone.
  const effectivePrompt = frame.imagePrompt;
  if (effectivePrompt) {
    // Distinguish "stored hash absent" from "stored hash matches". A null
    // stored hash means the image predates hash tracking (or was generated
    // by a pre-fix `generateShotImageFn` that didn't pass a sceneSnapshot)
    // — we genuinely have no opinion, so 'untracked' rather than lying with
    // 'fresh'. Once the user regenerates the image once under the new code
    // path, this column populates and the live-vs-stored comparison takes
    // over.
    if (frame.imageInputHash === null) {
      thumbnail = 'untracked';
    } else {
      try {
        const [characters, locations, elements] = refs
          ? [refs.characters, refs.locations, refs.elements]
          : await Promise.all([
              scopedDb.characters.listWithSheets(sequence.id),
              scopedDb.sequenceLocations.listWithReferences(sequence.id),
              scopedDb.sequenceElements.list(sequence.id),
            ]);

        const snapshot = await buildRegenerateShotSnapshot({
          shot: shotForHash,
          imagePrompt: frame.imagePrompt,
          characters,
          locations,
          elements,
          imageModel: safeTextToImageModel(
            frame.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
        });

        thumbnail =
          snapshot.snapshotInputHash !== frame.imageInputHash
            ? 'stale'
            : 'fresh';
      } catch (error) {
        // Mirror the visual/motion branches: a thumbnail-hash failure (e.g.
        // transient D1 read, malformed element/location row) must not throw
        // out of the whole handler — that would null the entire staleness
        // result and silently suppress the visual/motion banners too. Report
        // 'unknown' (fail-open as 'fresh' would lie about freshness).
        thumbnail = 'unknown';
        logger.warn(`thumbnail staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  let visualPrompt: ArtifactStaleness = 'untracked';
  let motionPrompt: ArtifactStaleness = 'untracked';

  // Reference hash resolution: prefer the cached column on `shots`, but
  // fall back to the most recent variant with a non-null `inputHash` for
  // shots whose cached column was nulled by a pre-fix user-edit. Without
  // the fallback, those shots are stuck at `'untracked'` permanently.
  if (scene) {
    // Visual prompt history moved to `frame_prompt_versions` (#989); the
    // cached hash mirror lives on the anchor frame.
    let referenceHash = frame.visualPromptInputHash;
    if (!referenceHash) {
      const fallback =
        await scopedDb.framePromptVersions.getLatestWithInputHash(frame.id);
      referenceHash = fallback?.inputHash ?? null;
    }
    if (referenceHash) {
      try {
        const latest = await scopedDb.framePromptVersions.getLatest(frame.id);
        const ctx = await loadNarrowShotPromptContext({
          scopedDb,
          sequence,
          scene,
          analysisModelOverride: latest?.analysisModel ?? null,
        });
        const liveHash = await computeVisualPromptInputHash(ctx);
        visualPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
      } catch (error) {
        // Context unavailable (e.g., style deleted mid-flight). Report
        // 'unknown' — fail-open as 'fresh' would silently lie to the user.
        visualPrompt = 'unknown';
        logger.warn(`visual staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  if (scene) {
    let referenceHash = shot.motionPromptInputHash;
    if (!referenceHash) {
      const fallback = await scopedDb.shotPromptVersions.getLatestWithInputHash(
        shot.id,
        'motion'
      );
      referenceHash = fallback?.inputHash ?? null;
    }
    if (referenceHash) {
      try {
        const latest = await scopedDb.shotPromptVersions.getLatest(
          shot.id,
          'motion'
        );
        const ctx = await loadNarrowShotPromptContext({
          scopedDb,
          sequence,
          scene,
          analysisModelOverride: latest?.analysisModel ?? null,
          startingFrameImageUrl: frame.imageUrl,
        });
        const liveHash = await computeMotionPromptInputHash(ctx);
        motionPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
      } catch (error) {
        motionPrompt = 'unknown';
        logger.warn(`motion staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  return { thumbnail, visualPrompt, motionPrompt };
}
