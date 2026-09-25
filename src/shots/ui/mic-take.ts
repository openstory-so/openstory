/**
 * A line recorded at the mic (#1802), turned into what the server takes:
 * 16-bit LE mono PCM at {@link MIC_TAKE_SAMPLE_RATE}. MediaRecorder hands back
 * whatever the browser encodes (Opus in WebM, AAC in MP4); the browser's own
 * decoder resamples it here, so the server never sees a codec.
 */

/** Plenty for a voice guide read, and a 30 s take stays under 1.5 MB. */
export const MIC_TAKE_SAMPLE_RATE = 24_000;
/** Seed takes a reference clip up to 30 s. */
export const MIC_TAKE_MAX_SECONDS = 30;

/** Float samples in [-1, 1] as 16-bit little-endian PCM. */
export function floatToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((sample, at) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      at * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true
    );
  });
  return out;
}

/** Decode a recorded blob to mono samples at {@link MIC_TAKE_SAMPLE_RATE}. */
export async function decodeTake(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(decoded.duration * MIC_TAKE_SAMPLE_RATE),
      MIC_TAKE_SAMPLE_RATE
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    void context.close();
  }
}
