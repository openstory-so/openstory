import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';

/** Display size from the file header. Does not decode the picture. */
export async function readVideoDisplaySize(file: string): Promise<{
  width: number;
  height: number;
}> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(file),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${file} has no video track`);
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    if (!(width > 0 && height > 0)) {
      throw new Error(`${file} reported invalid dimensions ${width}×${height}`);
    }
    return { width, height };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable video';
    if (message.startsWith(file)) throw error;
    throw new Error(`${file}: ${message}`);
  } finally {
    input.dispose();
  }
}
