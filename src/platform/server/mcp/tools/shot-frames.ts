import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { serializeShot } from '@/shots/server/inspection';
import type { ShotInspectionRead } from '@/shots/server/db/production-reads';
import type { StartFrameSequence } from '@/shots/use-start-frame';
import { productionAccess } from '@/sequences/server/production-access';
import { readToolDefinition, sequenceInput } from '../tool-context';
import {
  bytesToBase64,
  fetchJpeg,
  frameJpegUrl,
  isOpenStoryZoneUrl,
  sampleTimestamps,
  spritesheetJpegUrl,
  stillJpegUrl,
} from '../shot-frames';

const SHEET_TILES = 6;

type Jpeg = { data: string; mimeType: 'image/jpeg' };

const frameSchema = z.object({
  timestampMs: z.number().int(),
});

const shotFramesSchema = z.object({
  sequenceId: z.string(),
  shotId: z.string(),
  shotNumber: z.number().int(),
  durationMs: z.number().int(),
  prompt: z.string().nullable(),
  frames: z.array(frameSchema),
  unavailable: z.string().nullable(),
});

const contactShotSchema = z.object({
  shotId: z.string(),
  shotNumber: z.number().int(),
  sceneId: z.string().nullable(),
  durationMs: z.number().int(),
  prompt: z.string().nullable(),
  /** spritesheet tile times, the single frame time, or empty when unavailable. */
  timestampsMs: z.array(z.number().int()),
  kind: z.enum(['spritesheet', 'frame', 'still', 'unavailable']),
});

function promptOf(shot: ReturnType<typeof serializeShot>): string | null {
  const text = shot.motion.prompt ?? null;
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function zoneUrl(
  url: string | null | undefined,
  origin: string
): string | null {
  if (!url) return null;
  const absolute = toShareableUrl(url, origin);
  return isOpenStoryZoneUrl(absolute) ? absolute : null;
}

async function jpegAt(
  url: string,
  narrower: string
): Promise<Uint8Array | null> {
  return (await fetchJpeg(url)) ?? (await fetchJpeg(narrower));
}

async function framesForShot(
  read: ShotInspectionRead,
  sequence: StartFrameSequence,
  origin: string,
  count: number,
  maxWidth: number,
  timestampsMs: number[] | undefined
): Promise<{ data: z.input<typeof shotFramesSchema>; images: Jpeg[] }> {
  const shot = serializeShot(read, sequence, origin, {
    includeAssets: true,
    includePrompts: true,
  });
  const durationMs = shot.durationMs ?? 0;
  const times = sampleTimestamps(durationMs, count, timestampsMs);
  const video = zoneUrl(shot.motion.selectedVideo.url, origin);
  const still = zoneUrl(shot.anchorFrame?.selectedImage.url, origin);
  const images: Jpeg[] = [];
  const frames: { timestampMs: number }[] = [];
  let unavailable: string | null = null;

  if (video) {
    const narrow = Math.max(64, Math.floor(maxWidth / 2));
    for (const timestampMs of times) {
      const bytes = await jpegAt(
        frameJpegUrl(video, timestampMs, maxWidth),
        frameJpegUrl(video, timestampMs, narrow)
      );
      if (!bytes) continue;
      images.push({ data: bytesToBase64(bytes), mimeType: 'image/jpeg' });
      frames.push({ timestampMs });
    }
    if (frames.length === 0) {
      unavailable =
        'The clip is on OpenStory but frame extraction returned nothing.';
    }
  } else if (still) {
    const bytes = await jpegAt(
      stillJpegUrl(still, maxWidth),
      stillJpegUrl(still, Math.max(64, Math.floor(maxWidth / 2)))
    );
    if (bytes) {
      images.push({ data: bytesToBase64(bytes), mimeType: 'image/jpeg' });
      frames.push({ timestampMs: 0 });
    } else {
      unavailable = 'The start image is on OpenStory but could not be resized.';
    }
  } else {
    unavailable =
      'This shot has no zone-hosted video or start image to extract frames from.';
  }

  return {
    data: {
      sequenceId: shot.sequenceId,
      shotId: shot.id,
      shotNumber: shot.shotNumber ?? 0,
      durationMs,
      prompt: promptOf(shot),
      frames,
      unavailable,
    },
    images,
  };
}

export const getShotFrames = readToolDefinition({
  name: 'get_shot_frames',
  description:
    'Return JPEG frames of one shot inline as image content (no media URL to fetch). Default 4 frames evenly across the clip, including the start and the end, max 8. Use this to review motion, identity and performance when you cannot reach storage.openstory.so. Pass timestampsMs to sample specific instants. A shot with only a start image returns that image.',
  inputSchema: sequenceInput.extend({
    shotId: ulidSchema,
    count: z.int().min(1).max(8).default(4),
    maxWidth: z.int().min(64).max(512).default(512),
    timestampsMs: z.array(z.int().min(0).max(600_000)).max(8).optional(),
  }),
  outputSchema: shotFramesSchema,
  run: async (input, ctx) => {
    const access = productionAccess(ctx.scopedDb);
    const sequence = await access.sequence(input.sequenceId);
    await access.shot(sequence.id, input.shotId);
    const read = await ctx.scopedDb.shots.getDetail(sequence.id, input.shotId);
    const { data, images } = await framesForShot(
      read,
      sequence,
      ctx.origin,
      input.count,
      input.maxWidth,
      input.timestampsMs
    );
    const summary = data.unavailable
      ? `Shot ${data.shotNumber}: ${data.unavailable}`
      : `Shot ${data.shotNumber}: ${data.frames.length} frame(s) at ${data.frames.map((frame) => `${frame.timestampMs}ms`).join(', ')}.`;
    return { data, summary, images };
  },
});

export const getSequenceContactSheet = readToolDefinition({
  name: 'get_sequence_contact_sheet',
  description:
    'Return one inline JPEG per shot (a spritesheet of the clip, else one frame, else the start image) so a sequence can be reviewed without fetching media URLs. Pages 3 shots at a time: a 9-shot sequence is three calls. Pass nextCursor to continue. Image order matches shots whose kind is not unavailable. Spritesheet tiles run left to right, top to bottom, at timestampsMs.',
  inputSchema: sequenceInput.extend({
    shotIds: z.array(ulidSchema).max(3).optional(),
    limit: z.int().min(1).max(3).default(3),
    cursor: z.string().min(1).max(2048).optional(),
    maxWidth: z.int().min(64).max(480).default(320),
  }),
  outputSchema: z.object({
    sequenceId: z.string(),
    shots: z.array(contactShotSchema),
    nextCursor: z.string().nullable(),
  }),
  run: async (input, ctx) => {
    const access = productionAccess(ctx.scopedDb);
    const sequence = await access.sequence(input.sequenceId);
    let reads: ShotInspectionRead[];
    let nextCursor: string | null;
    if (input.shotIds) {
      reads = [];
      for (const shotId of input.shotIds) {
        await access.shot(sequence.id, shotId);
        reads.push(await ctx.scopedDb.shots.getDetail(sequence.id, shotId));
      }
      nextCursor = null;
    } else {
      const page = await ctx.scopedDb.shots.listPage({
        sequenceId: sequence.id,
        limit: input.limit,
        cursor: input.cursor,
        includeAssets: true,
        includePrompts: true,
      });
      reads = page.shots;
      nextCursor = page.nextCursor;
    }

    const shots: z.input<typeof contactShotSchema>[] = [];
    const images: Jpeg[] = [];
    for (const read of reads) {
      const view = serializeShot(read, sequence, ctx.origin, {
        includeAssets: true,
        includePrompts: true,
      });
      const video = zoneUrl(view.motion.selectedVideo.url, ctx.origin);
      const still = zoneUrl(view.anchorFrame?.selectedImage.url, ctx.origin);
      const durationMs = view.durationMs ?? 0;
      const times = sampleTimestamps(durationMs, SHEET_TILES);
      const base = {
        shotId: view.id,
        shotNumber: view.shotNumber ?? 0,
        sceneId: view.sceneId,
        durationMs,
        prompt: promptOf(view),
      };
      const narrow = Math.max(64, Math.floor(input.maxWidth / 2));
      if (video) {
        const sheet = await jpegAt(
          spritesheetJpegUrl(video, durationMs, SHEET_TILES, input.maxWidth),
          spritesheetJpegUrl(video, durationMs, SHEET_TILES, narrow)
        );
        if (sheet) {
          images.push({ data: bytesToBase64(sheet), mimeType: 'image/jpeg' });
          shots.push({ ...base, kind: 'spritesheet', timestampsMs: times });
          continue;
        }
        const mid = times[Math.floor(times.length / 2)] ?? 0;
        const frame = await jpegAt(
          frameJpegUrl(video, mid, input.maxWidth),
          frameJpegUrl(video, mid, narrow)
        );
        if (frame) {
          images.push({ data: bytesToBase64(frame), mimeType: 'image/jpeg' });
          shots.push({ ...base, kind: 'frame', timestampsMs: [mid] });
          continue;
        }
      }
      if (still) {
        const bytes = await jpegAt(
          stillJpegUrl(still, input.maxWidth),
          stillJpegUrl(still, narrow)
        );
        if (bytes) {
          images.push({ data: bytesToBase64(bytes), mimeType: 'image/jpeg' });
          shots.push({ ...base, kind: 'still', timestampsMs: [0] });
          continue;
        }
      }
      shots.push({ ...base, kind: 'unavailable', timestampsMs: [] });
    }

    const withImage = shots.filter(
      (shot) => shot.kind !== 'unavailable'
    ).length;
    return {
      data: { sequenceId: sequence.id, shots, nextCursor },
      summary: `${shots.length} shot(s), ${withImage} image(s)${nextCursor ? '; more available' : ''}.`,
      images,
    };
  },
});
