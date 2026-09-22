/**
 * Shot access middleware (#1489). Lives in the shots domain because it
 * resolves the shot's scene script — a domain read `platform/middleware.fn.ts`
 * may not make. Builds on `sequenceAccessMiddleware`, which already loaded
 * the sequence and re-scoped the db for a system admin crossing teams, so
 * this one never mints a scoped db itself.
 */
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { NotFoundError } from '@/platform/errors';
import {
  sequenceAccessMiddleware,
  type TeamContext,
} from '@/platform/middleware.fn';
import type { Frame, Shot } from '@/platform/server/db/schema';
import type { SequenceStatus } from '@/platform/server/db/schema/sequences';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import type { Scene } from '@/shots/scene-analysis.schema';
import { resolveSceneForShotFromDb } from '@/shots/server/scene-script';
import { createMiddleware } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/**
 * Partial sequence type returned by getShotWithSequence
 * Contains only the fields selected by the query
 */
type PartialSequence = {
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

export type ShotContext = TeamContext & {
  shot: Omit<Shot, 'sequence'>;
  frame: Frame;
  sequence: PartialSequence;
  /** Scene metadata with the selected script version overlaid (#1030). */
  scene: Scene | null;
  /** Selected scene script content, when available. */
  script: Scene['originalScript'] | null;
};

/**
 * Shot access middleware
 * Loads shot with its sequence and verifies team access
 * Requires sequenceId and shotId in input data
 */
export const shotAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(z.looseObject({ sequenceId: ulidSchema, shotId: ulidSchema }))
  )
  .server(async ({ next, context, data }) => {
    const { scopedDb } = context;
    const shotData = await scopedDb.shots.getWithSequence(data.shotId);

    if (!shotData || shotData.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Shot not found in this sequence');
    }

    // Extract sequence from shot data (using the partial sequence from the query)
    const { sequence: rawSequence, ...shot } = shotData;

    // Anchor frame (#989) — the shot's IMAGE surface (was the shots.thumbnail*
    // columns): its first frame (orderIndex 0), resolved by shotId, never by
    // id-reuse. Every shot owns one (created at shot-create / backfilled by the
    // Phase 2 migration); create it defensively if a legacy shot predates it.
    let frame = await scopedDb.frames.getAnchorByShot(shot.id);
    if (!frame) {
      await scopedDb.shots.ensureAnchorFrames([shot]);
      frame = await scopedDb.frames.getAnchorByShot(shot.id);
    }
    if (!frame) {
      throw new NotFoundError('Shot is missing its anchor frame');
    }

    // Type assertion needed because Drizzle's nested relation inference loses the $type<AspectRatio>() annotation
    const sequence: PartialSequence = {
      ...rawSequence,
      aspectRatio: rawSequence.aspectRatio satisfies AspectRatio,
      resolution: rawSequence.resolution satisfies Resolution,
    };

    const { scene, script } = await resolveSceneForShotFromDb(shot, scopedDb);

    return next({
      context: {
        shot,
        frame,
        sequence,
        scene,
        script,
      },
    });
  });
