/**
 * What every shot-level edit needs: the shot, its anchor frame, the slice of
 * its sequence the shot services read, and its resolved scene script. The
 * editor's `shotAccessMiddleware` and the MCP shot tools both load it here.
 */
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Frame, Shot, User } from '@/platform/server/db/schema';
import type { SequenceStatus } from '@/platform/server/db/schema/sequences';
import type { Scene } from '@/shots/scene-analysis.schema';
import { resolveSceneForShotFromDb } from './scene-script';

/** The sequence fields `getWithSequence` selects. */
type ShotSequence = {
  id: string;
  teamId: string;
  title: string;
  /** Narrow, not `string`: staleness defers while the sequence is
   * 'processing' (#1121), and that check must not be a string compare. */
  status: SequenceStatus;
  styleId: string | null;
  imageModel: string;
  videoModel: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  analysisModel: string;
  /** Sequence default for the start-frame mode; see `usesStartFrame()`. */
  generateStartFrames: boolean;
  /** Render motion as Ark drafts (#1756). */
  draftMotion: boolean;
};

export type ShotTarget = {
  shot: Omit<Shot, 'sequence'>;
  frame: Frame;
  sequence: ShotSequence;
  /** Scene metadata with the selected script version overlaid (#1030). */
  scene: Scene | null;
  /** Selected scene script content, when available. */
  script: Scene['originalScript'] | null;
};

/** A shot edit's context: the target plus who acts, in which team. */
export type ShotEditContext = ShotTarget & {
  scopedDb: ScopedDb;
  user: Pick<User, 'id'>;
  teamId: string;
};

/**
 * Load a shot of this sequence (live or soft-deleted, as the editor does) with
 * its anchor frame and scene. Callers check the sequence's team first.
 */
export async function loadShotTarget(
  scopedDb: ScopedDb,
  sequenceId: string,
  shotId: string
): Promise<ShotTarget> {
  const shotData = await scopedDb.shots.getWithSequence(shotId);
  if (!shotData || shotData.sequenceId !== sequenceId) {
    throw new NotFoundError('Shot not found in this sequence');
  }
  const { sequence: rawSequence, ...shot } = shotData;

  // Anchor frame (#989) — the shot's IMAGE surface: its first frame
  // (orderIndex 0), resolved by shotId, never by id-reuse. Every shot owns
  // one; create it defensively if a legacy shot predates it.
  let frame = await scopedDb.frames.getAnchorByShot(shot.id);
  if (!frame) {
    await scopedDb.shots.ensureAnchorFrames([shot]);
    frame = await scopedDb.frames.getAnchorByShot(shot.id);
  }
  if (!frame) {
    throw new NotFoundError('Shot is missing its anchor frame');
  }

  // Drizzle's nested relation inference loses the $type<AspectRatio>() annotation.
  const sequence: ShotSequence = {
    ...rawSequence,
    aspectRatio: rawSequence.aspectRatio satisfies AspectRatio,
    resolution: rawSequence.resolution satisfies Resolution,
  };

  const { scene, script } = await resolveSceneForShotFromDb(shot, scopedDb);
  return { shot, frame, sequence, scene, script };
}
