/**
 * Client-safe limits for voice input (dictating scripts and prompts). Shared
 * by the browser recorder hook and the server fn's input schema, so it must
 * stay free of server-only imports — `src/functions/voice.ts` is imported by
 * the client for its RPC stub and anything referenced at module level there
 * lands in the browser bundle (#1257).
 */

/** Longest single take before the recorder stops itself. */
export const MAX_VOICE_RECORDING_MS = 3 * 60 * 1000;

/**
 * Upper bound on one recording's bytes. Three minutes of Opus (Chrome /
 * Firefox, ~32 kbps) is under 1 MB; Safari records AAC in an MP4 container at
 * up to ~128 kbps, so ~3 MB. 8 MB leaves headroom without letting a runaway
 * client post an arbitrarily large body.
 */
const MAX_VOICE_AUDIO_BYTES = 8 * 1024 * 1024;

/** `MAX_VOICE_AUDIO_BYTES` after base64 expansion (4 chars per 3 bytes). */
export const MAX_VOICE_AUDIO_BASE64_CHARS =
  Math.ceil(MAX_VOICE_AUDIO_BYTES / 3) * 4;

/**
 * Takes shorter than this are a mis-click on the mic, not speech — they are
 * discarded client-side without a transcription call.
 */
export const MIN_VOICE_RECORDING_MS = 400;
