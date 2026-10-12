/**
 * @openstory/stitch-player — plays N clip videos and timed stills as one
 * sequence on a canvas, in the browser, with music, per-clip dialogue and
 * subtitles. Playback and export need WebCodecs (via mediabunny) and Web
 * Audio. The modules themselves import under Node.
 *
 * Entry points:
 * - `@openstory/stitch-player`         this file: the engine, no framework.
 * - `@openstory/stitch-player/videojs` a Video.js 10 media adapter.
 * - `@openstory/stitch-player/react`   a React surface under the Video.js skin.
 * - `@openstory/stitch-player/export`  in-browser MP4 export of the same stitch.
 */
export {
  SequencePlayerEngine,
  type SequencePlayerMeta,
  type SequencePlayerOptions,
} from './playback.js';
export {
  ConcatenatedVideoSource,
  type ClipAudioTrack,
  type ClipSlice,
  type ConcatenatedVideoMeta,
} from './concatenated-video-source.js';
export {
  assertPlaybackClips,
  type PlaybackClip,
  type PlaybackCue,
} from './playback-clip.js';
export { playbackClipsKey } from './playback-clips-key.js';
export { cueTextAt } from './cues.js';
export { cuesToWebVTT } from './webvtt.js';
export { createRangedReader, createRangedSource } from './ranged-source.js';
export { computeMusicGain, loudnessDbToLinear } from './music-gain.js';
export {
  playAttemptUiState,
  settlePlayWait,
  type PlayAttemptResult,
  type PlayWaitSettlement,
} from './play-attempt.js';
export {
  computeTargetResolution,
  describeResolutions,
  detectMixedAspectRatios,
  detectMixedResolutions,
  type ClipDimensions,
} from './resolution.js';
export {
  forAwaitUntilDisposed,
  isInputDisposedError,
} from './disposed-iterator.js';
export type { StitchLogger } from './logger.js';
