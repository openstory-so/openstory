import { NotFoundError, ValidationError } from '@/platform/errors';
import { generateId, isValidId } from '@/platform/id';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { getPublicStitch } from '@/platform/server/db/scoped';
import { getProductionDeploymentAppUrl } from '@/platform/server/env/environment';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { aspectRatioToDimensions } from '@/models/aspect-ratios';
import { toPlaybackClips } from '@/sequences/ui/theatre/playback-clips';
import { loadShotViews } from '@/shots/server/load-shot-views';
import { cutSchemaOf, openingPicture } from '@/stitches/cut';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * A shared stitch for its public page (#2127). No auth: the id is the link.
 * Only a published row is a page; one still uploading is not found.
 * `preview` is the opening picture as an absolute URL for the social card
 * (#2140); null when the cut opens on a video with no poster, or the picture's
 * type is not known from its name.
 */
export const getStitchFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(z.object({ id: z.string().min(1).max(64) })))
  .handler(async ({ data }) => {
    const stitch = isValidId(data.id) ? await getPublicStitch(data.id) : null;
    if (!stitch) throw new NotFoundError('This stitch does not exist');
    const origin = getProductionDeploymentAppUrl(getRequest());
    const picture = openingPicture(stitch.cut);
    const extension = picture
      ?.split(/[?#]/)[0]
      ?.split('.')
      .pop()
      ?.toLowerCase();
    const type = extension ? IMAGE_TYPES[extension] : undefined;
    return {
      cut: stitch.cut,
      createdAt: stitch.createdAt,
      pageUrl: `${origin}/stitch/${stitch.id}`,
      preview:
        picture && type ? { url: toShareableUrl(picture, origin), type } : null,
    };
  });

/** The stored cut's shape, with plain-string media: copies readonly arrays. */
const storedCutSchema = cutSchemaOf(z.string().min(1));

/**
 * Share a sequence as a stitch (#2140): the whole cut the theatre plays —
 * rendered clips where the shot has one, stills elsewhere, and the music when
 * it is on — stored as a published row. Built here from the team's own shots,
 * never from URLs the browser sends, so the row points only at the team's
 * media. Like "Copy link" on a render, it makes the cut public by its id.
 */
export const shareSequenceStitchFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb, sequence } = context;
    const clips = toPlaybackClips(
      await loadShotViews(scopedDb, sequence),
      sequence.aspectRatio
    );
    if (clips.length === 0) {
      throw new ValidationError('This sequence has no shots to share yet.');
    }
    const frame = aspectRatioToDimensions(sequence.aspectRatio);
    const cut = storedCutSchema.parse({
      clips,
      frameWidth: frame.width,
      frameHeight: frame.height,
      musicUrl: sequence.includeMusic ? (sequence.musicUrl ?? null) : null,
      musicGainDb: 0,
    });
    const id = generateId();
    await scopedDb.stitches.create({ id, cut, publishedAt: new Date() });
    return { id };
  });
