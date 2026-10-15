import { ALL_FORMATS, FilePathSource, Input, UrlSource } from 'mediabunny';

/** True for an http(s) URL. Anything else is a path on disk. */
export function isHttpUrl(file: string): boolean {
  return /^https?:\/\//i.test(file);
}

function sourceFor(file: string): FilePathSource | UrlSource {
  return isHttpUrl(file) ? new UrlSource(file) : new FilePathSource(file);
}

/**
 * Display size and duration from the file header. Duration uses container
 * metadata first, the same order the player uses, and does not decode.
 */
export async function readVideoDisplaySize(file: string): Promise<{
  width: number;
  height: number;
  durationSeconds: number;
}> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: sourceFor(file),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${file} has no video track`);
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    if (!(width > 0 && height > 0)) {
      throw new Error(`${file} reported invalid dimensions ${width}×${height}`);
    }
    const durationSeconds = await trackDuration(input, [track], file);
    return { width, height, durationSeconds };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable video';
    if (message.startsWith(file)) throw error;
    throw new Error(`${file}: ${message}`);
  } finally {
    input.dispose();
  }
}

/** Duration of a dialogue or music file from its header. Does not decode. */
export async function readAudioDuration(file: string): Promise<number> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: sourceFor(file),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`${file} has no audio track`);
    return await trackDuration(input, [track], file);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable audio';
    if (message.startsWith(file)) throw error;
    throw new Error(`${file}: ${message}`);
  } finally {
    input.dispose();
  }
}

async function trackDuration(
  input: Input,
  tracks: Parameters<Input['getDurationFromMetadata']>[0],
  file: string
): Promise<number> {
  const fromMetadata = await input.getDurationFromMetadata(tracks, {
    skipLiveWait: true,
  });
  const duration =
    fromMetadata ??
    (await input.computeDuration(tracks, { skipLiveWait: true }));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${file} has no playable duration`);
  }
  return duration;
}
