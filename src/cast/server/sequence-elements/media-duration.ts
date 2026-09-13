/**
 * How long a stored clip or audio element runs, read from its own container
 * (#1559).
 *
 * The browser measures a file as it is uploaded, but not every row gets that
 * number: an API caller never sends one, a draft saved before the field
 * existed restores without it, and a browser that cannot decode a codec gives
 * up. Every length gate treats an unknown length as "fits" — guessing "too
 * long" would drop a reference the provider might take — so a row with no
 * length is a row nothing checks. That is how a 20-second clip reached
 * MiniMax H3 Max and came back as a provider error after the user had already
 * clicked Generate.
 *
 * So the server works the length out itself. It reads only the byte ranges
 * the demuxer asks for — an MP4's `moov`, a WAV or MP3 header — through
 * ranged R2 reads, and decodes nothing, so a large clip costs a few kilobytes.
 */

import { readStorageObject, storageObjectSize } from '#storage';
import { ALL_FORMATS, CustomSource, Input } from 'mediabunny';
import type { SequenceElement } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cast', 'media-duration']);

/**
 * Seconds of media in the stored object at `key` (`elements/<team>/…`, which
 * is also the element row's `imagePath`), or null when the container does not
 * say or cannot be read.
 */
export async function measureStoredMediaDuration(
  key: string
): Promise<number | null> {
  const size = await storageObjectSize(key);
  if (!size) return null;

  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: () => size,
      read: async (start, end) => {
        const object = await readStorageObject(key, {
          offset: start,
          length: end - start,
        });
        if (!object) throw new Error(`Storage object disappeared: ${key}`);
        return object.bytes;
      },
    }),
  });
  try {
    // The header answers for almost every file; a stream with no duration in
    // its metadata (an MP3 with no Xing frame) falls back to walking packets.
    const seconds =
      (await input.getDurationFromMetadata()) ??
      (await input.computeDuration());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (error) {
    // An unrecognisable container. Unknown is what the row already said, so
    // this changes nothing — but log it, because it means this file will
    // pass every length gate unchecked.
    logger.warn('Could not read media duration', { key, error });
    return null;
  } finally {
    input.dispose();
  }
}

type MeasurableElement = Pick<
  SequenceElement,
  'id' | 'kind' | 'durationSeconds' | 'imagePath'
>;

/**
 * The same elements, with any clip or audio file that has no length measured
 * and the result written back — so each row is probed at most once, and every
 * reader after it (the length gates, the tile badge, the next render) sees
 * the real number.
 *
 * Called where elements are read to be RENDERED or SHOWN, not only where they
 * are created, because the rows that need it most already exist.
 */
export async function withMeasuredDurations<T extends MeasurableElement>(
  scopedDb: ScopedDb,
  elements: T[]
): Promise<T[]> {
  return Promise.all(
    elements.map(async (element) => {
      if (
        element.kind === 'image' ||
        element.durationSeconds !== null ||
        !element.imagePath
      ) {
        return element;
      }
      const durationSeconds = await measureStoredMediaDuration(
        element.imagePath
      );
      if (durationSeconds === null) return element;
      await scopedDb.sequenceElements.update(element.id, { durationSeconds });
      return { ...element, durationSeconds };
    })
  );
}
