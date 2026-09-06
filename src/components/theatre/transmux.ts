/**
 * Transmux-compatibility checks for stitched sequences.
 *
 * The export pipeline can concatenate encoded packets without re-encoding
 * ("transmux") only when every scene is AVC with a byte-identical decoder
 * config (SPS/PPS). Mixed-model sequences (#791) usually violate this — a
 * different resolution implies a different SPS — and must take the
 * decode→normalize→re-encode path instead.
 *
 * Like `resolution.ts`, this module is pure (no Mediabunny surface) so the
 * decision logic that gates a hard export failure vs. a silent slow re-encode
 * can be unit-tested in isolation. `ConcatenatedVideoSource` probes each
 * scene's codec + decoder config and feeds the results here.
 */

export type SceneCodecProbe = {
  /** Codec id from Mediabunny's `getCodec()`, e.g. `'avc'`. */
  codec: string | null;
  /** Hex of the decoder config description (SPS/PPS); `''` when absent. */
  descriptionHex: string;
};

/**
 * True when every probed scene is AVC with the same non-empty decoder config,
 * so packets can be concatenated as-is. Any non-AVC codec, missing/empty
 * decoder config, or config differing from scene 0 forces the re-encode path.
 */
export function canTransmuxScenes(probes: SceneCodecProbe[]): boolean {
  const first = probes[0];
  if (!first) return false;
  return probes.every(
    (probe) =>
      probe.codec === 'avc' &&
      probe.descriptionHex.length > 0 &&
      probe.descriptionHex === first.descriptionHex
  );
}

/**
 * Hex-encode a `VideoDecoderConfig`'s `description` (the avcC box / SPS+PPS)
 * for cheap byte-identity comparison across scenes. Returns `''` when the
 * config has no usable description. Respects `byteOffset`/`byteLength` on
 * typed-array views — reading the whole underlying buffer would make two
 * distinct configs compare equal.
 */
export function decoderConfigDescriptionHex(
  config: VideoDecoderConfig
): string {
  const desc = config.description;
  if (!desc) return '';
  const view =
    desc instanceof ArrayBuffer
      ? new Uint8Array(desc)
      : ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : null;
  if (!view || view.length === 0) return '';
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}
