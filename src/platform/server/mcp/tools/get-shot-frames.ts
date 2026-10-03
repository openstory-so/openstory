import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { ValidationError } from '@/platform/errors';
import { productionAccess } from '@/sequences/server/production-access';
import {
  prepareReviewVideo,
  readReviewFrame,
  reviewTimestamps,
  reviewWindow,
} from '@/motion/server/review-frames';
import { readToolDefinition, sequenceInput } from '../tool-context';

const inputSchema = sequenceInput.extend({
  shotId: ulidSchema.optional(),
  shotIds: z.array(ulidSchema).min(1).max(3).optional(),
  limit: z.int().min(1).max(3).default(3),
  cursor: z.string().min(1).max(2048).optional(),
  count: z.int().min(2).max(8).default(4),
  maxWidth: z.int().min(128).max(768).default(512),
  timestampsMs: z.array(z.number().nonnegative()).min(1).max(8).optional(),
});
const shotResultSchema = z.object({
  shotId: z.string(),
  shotNumber: z.number().nullable(),
  videoVersionId: z.string().nullable(),
  currentMotionPrompt: z.string().nullable(),
  status: z.enum(['ready', 'unavailable']),
  error: z.string().nullable(),
  window: z
    .object({
      startMs: z.number(),
      durationMs: z.number(),
      source: z.enum(['render_manifest', 'whole_clip']),
    })
    .nullable(),
  frames: z.array(
    z.object({
      imageIndex: z.int(),
      timestampMs: z.number(),
      clipTimestampMs: z.number(),
    })
  ),
});

export const getShotFrames = readToolDefinition({
  name: 'get_shot_frames',
  description:
    'View selected shot videos inline as JPEG image content, without fetching media URLs. Requires sequenceId; optionally select shotId or up to 3 shotIds, otherwise pages 3 shots in story order using nextCursor. Defaults to 4 evenly spaced frames including the first and final visible frame; count 2–8, maxWidth 128–768 (default 512, bounds both dimensions). timestampsMs overrides count and is relative to each shot window. Windows use the selected render manifest; empty legacy manifests return the whole clip, labelled whole_clip. frame imageIndex is zero-based among image blocks. Requires stored media on the Cloudflare transformation zone; failures are reported per shot. currentMotionPrompt is working context, not necessarily the rendered prompt. No generation or selection changes.',
  inputSchema,
  outputSchema: z.object({
    sequenceId: z.string(),
    shots: z.array(shotResultSchema),
    nextCursor: z.string().nullable(),
  }),
  run: async (input, { scopedDb }) => {
    if (
      (input.shotId && input.shotIds) ||
      ((input.shotId || input.shotIds) && input.cursor)
    ) {
      throw new ValidationError(
        'Use shotId, shotIds, or sequence pagination, not a combination.'
      );
    }
    const access = productionAccess(scopedDb);
    await access.sequence(input.sequenceId);
    const ids = input.shotId ? [input.shotId] : input.shotIds;
    // Check every explicit ID before reading any media, including mixed-team batches.
    if (ids) for (const id of ids) await access.shot(input.sequenceId, id);
    const page = ids
      ? {
          shots: await Promise.all(
            ids.map((id) => scopedDb.shots.getDetail(input.sequenceId, id))
          ),
          nextCursor: null,
        }
      : await scopedDb.shots.listPage({
          ...input,
          includeAssets: true,
          includePrompts: true,
        });
    const shots: z.infer<typeof shotResultSchema>[] = [];
    const images: Awaited<ReturnType<typeof readReviewFrame>>[] = [];
    const prepared = new Map<
      string,
      Awaited<ReturnType<typeof prepareReviewVideo>>
    >();
    for (const read of page.shots) {
      const shot = read.view;
      const result: z.infer<typeof shotResultSchema> = {
        shotId: shot.id,
        shotNumber: shot.shotNumber,
        videoVersionId: read.selectedVideoId,
        currentMotionPrompt: shot.motionPrompt?.fullPrompt ?? null,
        status: 'unavailable',
        error: null,
        window: null,
        frames: [],
      };
      try {
        if (!read.selectedVideoUsable || !shot.video?.url)
          throw new ValidationError('No usable selected video for this shot.');
        let video = prepared.get(shot.video.url);
        if (!video) {
          video = await prepareReviewVideo(shot.video.url);
          prepared.set(shot.video.url, video);
        }
        result.window = reviewWindow(
          shot.id,
          shot.video.manifest,
          video.durationMs
        );
        const times = reviewTimestamps(
          result.window.durationMs,
          input.count,
          input.timestampsMs
        );
        // A shot is atomic: a failed frame must not leave unlabelled image blocks.
        const window = result.window;
        const sampled = await Promise.allSettled(
          times.map((time) =>
            readReviewFrame(video.url, window.startMs + time, input.maxWidth)
          )
        );
        const shotImages = sampled.map((frame) => {
          if (frame.status === 'rejected') throw frame.reason;
          return frame.value;
        });
        result.frames = times.map((time, index) => ({
          imageIndex: images.length + index,
          timestampMs: time,
          clipTimestampMs: window.startMs + time,
        }));
        images.push(...shotImages);
        result.status = 'ready';
      } catch (error) {
        result.error =
          error instanceof ValidationError
            ? error.message
            : 'Frame extraction failed. Retry this shot.';
      }
      shots.push(result);
    }
    return {
      data: {
        sequenceId: input.sequenceId,
        shots,
        nextCursor: page.nextCursor,
      },
      summary: `${images.length} video frames from ${shots.filter((shot) => shot.status === 'ready').length} shots. Image blocks follow the shot/frame order in the metadata.`,
      images,
    };
  },
});
