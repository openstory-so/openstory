/**
 * Music alongside the theatre's playlist (#1623). The playlist is the clips
 * themselves and HLS cannot mix a second audio track in, so the music plays in
 * an <audio> element of its own that follows the video: play, pause, seek,
 * rate, volume. Turning it on or off is live — nothing reloads.
 */

import { useEffect } from 'react';

/** Drift past this is corrected; under it a re-seek would be the louder glitch. */
const MAX_DRIFT_SECONDS = 0.3;

export function useTheatreMusic(
  video: HTMLMediaElement | null,
  musicUrl: string | null,
  enabled: boolean
): void {
  useEffect(() => {
    if (!video || !musicUrl || !enabled) return;
    const audio = new Audio(musicUrl);
    audio.preload = 'auto';

    const follow = () => {
      audio.volume = video.volume;
      audio.muted = video.muted;
      audio.playbackRate = video.playbackRate;
      // Music shorter than the cut just ends; never wrap it around.
      const pastEnd =
        Number.isFinite(audio.duration) && video.currentTime >= audio.duration;
      if (
        !pastEnd &&
        Math.abs(audio.currentTime - video.currentTime) > MAX_DRIFT_SECONDS
      ) {
        audio.currentTime = video.currentTime;
      }
      // `readyState < 3` = the video is waiting on data: hold the music too.
      const playing =
        !video.paused && !video.ended && video.readyState >= 3 && !pastEnd;
      if (playing && audio.paused) {
        void audio.play().catch(() => {
          // Autoplay blocked: the next user gesture on the player retries.
        });
      } else if (!playing && !audio.paused) {
        audio.pause();
      }
    };

    const events = [
      'play',
      'playing',
      'pause',
      'waiting',
      'seeking',
      'seeked',
      'ended',
      'ratechange',
      'volumechange',
      'timeupdate',
    ];
    for (const e of events) video.addEventListener(e, follow);
    follow();
    return () => {
      for (const e of events) video.removeEventListener(e, follow);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [video, musicUrl, enabled]);
}
