/**
 * A shared stitch (#2127): the cut `stitch share` uploads, as the player page
 * reads it. It is the stitch CLI's `cut.json`. On the wire every media URL is
 * a bundle name, `media/<n>.<ext>`; the server rewrites each to the stored
 * `/r2/...` URL before the row is written, so a stored cut never points at a
 * file the team did not upload.
 */

import { z } from 'zod';

/** `media/<n>.<ext>`: what the CLI names a file in a bundle. */
const STITCH_MEDIA_NAME = /^media\/\d{1,4}\.[a-z0-9]{1,5}$/;

const mediaName = z
  .string()
  .regex(STITCH_MEDIA_NAME, 'Not a bundle media name');

const cueSchema = z.object({
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  text: z.string().max(2_000),
});

const videoClipSchema = z.object({
  videoUrl: mediaName,
  posterUrl: mediaName.nullable(),
  cues: z.array(cueSchema).max(500),
});

const stillClipSchema = z.object({
  imageUrl: mediaName.nullable(),
  fallbackImageUrl: mediaName.nullable(),
  durationSeconds: z.number().positive(),
  audioUrls: z.array(mediaName).max(50),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  cues: z.array(cueSchema).max(500),
});

export const stitchCutSchema = z.object({
  clips: z
    .array(z.union([videoClipSchema, stillClipSchema]))
    .min(1)
    .max(500),
  frameWidth: z.number().positive(),
  frameHeight: z.number().positive(),
  musicUrl: mediaName.nullable(),
  musicGainDb: z.number().finite(),
});

export type StitchCut = z.infer<typeof stitchCutSchema>;

/**
 * The same cut with every media name replaced through `url`. The stored form
 * passes the storage URL for that name; `mediaNames` lists what has to be
 * uploaded.
 */
export function mapCutMedia(
  cut: StitchCut,
  url: (name: string) => string
): StitchCut {
  const maybe = (name: string | null) => (name === null ? null : url(name));
  return {
    ...cut,
    musicUrl: maybe(cut.musicUrl),
    clips: cut.clips.map((clip) =>
      'videoUrl' in clip
        ? {
            ...clip,
            videoUrl: url(clip.videoUrl),
            posterUrl: maybe(clip.posterUrl),
          }
        : {
            ...clip,
            imageUrl: maybe(clip.imageUrl),
            fallbackImageUrl: maybe(clip.fallbackImageUrl),
            audioUrls: clip.audioUrls.map(url),
          }
    ),
  };
}
