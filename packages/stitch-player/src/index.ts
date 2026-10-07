/**
 * @openstory/stitch-player — plays N clip videos and timed stills as one
 * sequence on a canvas, in the browser, with music, per-clip dialogue and
 * subtitles. Browser-only: WebCodecs (via mediabunny) + Web Audio.
 *
 * Entry points:
 * - `@openstory/stitch-player`         this file: the engine, no framework.
 * - `@openstory/stitch-player/videojs` a Video.js 10 media adapter.
 * - `@openstory/stitch-player/react`   a React surface under the Video.js skin.
 */
export {
  SequencePlayerEngine,
  type SequencePlayerMeta,
  type SequencePlayerOptions,
} from './playback';
export {
  ConcatenatedVideoSource,
  type ClipAudioTrack,
  type ClipSlice,
  type ConcatenatedVideoMeta,
} from './concatenated-video-source';
export type { PlaybackClip, PlaybackCue } from './playback-clip';
export { playbackClipsKey } from './playback-clips-key';
export { cueTextAt } from './cues';
export { cuesToWebVTT } from './webvtt';
export { createRangedReader, createRangedSource } from './ranged-source';
export { computeMusicGain, loudnessDbToLinear } from './music-gain';
export {
  playAttemptUiState,
  settlePlayWait,
  type PlayAttemptResult,
  type PlayWaitSettlement,
} from './play-attempt';
export {
  computeTargetResolution,
  describeResolutions,
  detectMixedAspectRatios,
  detectMixedResolutions,
  type ClipDimensions,
} from './resolution';
export {
  forAwaitUntilDisposed,
  isInputDisposedError,
} from './disposed-iterator';
export type { StitchLogger } from './logger';
