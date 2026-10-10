/**
 * Pure gain math for the live playback engine and the MP4 export, kept free of
 * the Mediabunny / Web-Audio surface so it can be unit-tested in isolation.
 */

/**
 * Convert a measured loudness adjustment in decibels to a linear gain factor.
 * Returns 1 (unity) when there is no normalization value or it is non-finite.
 */
export function loudnessDbToLinear(loudnessGainDb: number | null): number {
  if (loudnessGainDb === null || !Number.isFinite(loudnessGainDb)) return 1;
  return Math.pow(10, loudnessGainDb / 20);
}

/**
 * Resolve the linear gain for the music-only node. Returns 0 when music is
 * toggled off (the #834 mute contract); otherwise the loudness-normalized
 * linear gain. Scene/dialogue audio routes through the master gain and is
 * unaffected by this value.
 */
export function computeMusicGain(
  musicEnabled: boolean,
  musicLoudnessGainDb: number | null
): number {
  return musicEnabled ? loudnessDbToLinear(musicLoudnessGainDb) : 0;
}
