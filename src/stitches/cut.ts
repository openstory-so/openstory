/**
 * A shared stitch (#2127): the cut the player page reads, as the stitch CLI's
 * `cut.json`. The media slots are generic: on the API wire each is a bundle
 * name (`media/<n>.<ext>`), to the MCP tool each is a URL or inline bytes,
 * and in the row each is the stored `/r2/...` URL. The server rewrites names
 * and sources to stored URLs before the row is written, so a stored cut never
 * points at a file the team did not upload.
 */

import { z } from 'zod';

/**
 * The extensions the player plays: `UPLOAD_EXTENSIONS` (image, video, audio)
 * in `src/shots/server/upload-media.ts`, which this client-safe file cannot
 * import. `stitch-storage.test.ts` pins the two lists equal.
 */
export const STITCH_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'mp4',
  'webm',
  'mov',
  'mp3',
  'wav',
  'ogg',
  'm4a',
] as const;

/** `media/<n>.<ext>`: what the CLI names a file in a bundle. */
const STITCH_MEDIA_NAME = new RegExp(
  `^media/\\d{1,4}\\.(${STITCH_EXTENSIONS.join('|')})$`
);

const mediaName = z
  .string()
  .regex(STITCH_MEDIA_NAME, 'Not a bundle media name');

const cueSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    text: z.string().max(2_000),
  })
  .refine((cue) => cue.startSeconds < cue.endSeconds, {
    message: 'A cue ends after it starts',
    path: ['endSeconds'],
  });

/** The cut with every media slot of type `media`. */
export function cutSchemaOf<M extends z.ZodType>(media: M) {
  const videoClip = z.object({
    videoUrl: media,
    posterUrl: media.nullable(),
    cues: z.array(cueSchema).max(500),
  });
  const stillClip = z.object({
    imageUrl: media.nullable(),
    fallbackImageUrl: media.nullable(),
    durationSeconds: z.number().positive(),
    audioUrls: z.array(media).max(50),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    cues: z.array(cueSchema).max(500),
  });
  return z.object({
    clips: z
      .array(z.union([videoClip, stillClip]))
      .min(1)
      .max(500),
    frameWidth: z.number().positive(),
    frameHeight: z.number().positive(),
    musicUrl: media.nullable(),
    musicGainDb: z.number().finite(),
  });
}

export const stitchCutSchema = cutSchemaOf(mediaName);

export type StitchCut = z.infer<typeof stitchCutSchema>;

/** What a slot holds: a video, a picture, or sound. */
export type MediaRole = 'video' | 'image' | 'audio';

type Cut<M> = {
  clips: (
    | {
        videoUrl: M;
        posterUrl: M | null;
        cues: StitchCut['clips'][number]['cues'];
      }
    | {
        imageUrl: M | null;
        fallbackImageUrl: M | null;
        durationSeconds: number;
        audioUrls: M[];
        width: number;
        height: number;
        cues: StitchCut['clips'][number]['cues'];
      }
  )[];
  frameWidth: number;
  frameHeight: number;
  musicUrl: M | null;
  musicGainDb: number;
};

/** The same cut with every media slot replaced through `url`, told its role. */
export function mapCutMedia<A, B>(
  cut: Cut<A>,
  url: (media: A, role: MediaRole) => B
): Cut<B> {
  const maybe = (media: A | null, role: MediaRole) =>
    media === null ? null : url(media, role);
  return {
    ...cut,
    musicUrl: maybe(cut.musicUrl, 'audio'),
    clips: cut.clips.map((clip) =>
      'videoUrl' in clip
        ? {
            ...clip,
            videoUrl: url(clip.videoUrl, 'video'),
            posterUrl: maybe(clip.posterUrl, 'image'),
          }
        : {
            ...clip,
            imageUrl: maybe(clip.imageUrl, 'image'),
            fallbackImageUrl: maybe(clip.fallbackImageUrl, 'image'),
            audioUrls: clip.audioUrls.map((a) => url(a, 'audio')),
          }
    ),
  };
}

/**
 * The picture the cut opens on (#2140): the first clip's poster, or its still
 * (else that still's fallback). Null when the first clip has none — a video
 * shared with no poster. The social preview shows it.
 */
export function openingPicture<M>(cut: Cut<M>): M | null {
  const first = cut.clips[0];
  if (!first) return null;
  return 'videoUrl' in first
    ? first.posterUrl
    : (first.imageUrl ?? first.fallbackImageUrl);
}
