/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client';
import '@videojs/react/video/neutral-skin.css';
import { StitchedPlayer } from '../src/react';
import type { PlaybackClip } from '../src/playback-clip';

const media = (name: string) => `${import.meta.env.BASE_URL}${name}`;

// Shot 1 is a still, so its line is a separate file. The two clips already
// carry their own dialogue; the player plays that track.
const clips: PlaybackClip[] = [
  {
    imageUrl: media('still.png'),
    fallbackImageUrl: null,
    durationSeconds: 3,
    audioUrls: [media('line.wav')],
    width: 1024,
    height: 576,
    cues: [{ startSeconds: 0, endSeconds: 2, text: 'Coming over?' }],
  },
  {
    videoUrl: media('shot2.mp4'),
    posterUrl: null,
    cues: [{ startSeconds: 0, endSeconds: 3.6, text: 'Love that accent.' }],
  },
  {
    videoUrl: media('shot3.mp4'),
    posterUrl: null,
    cues: [{ startSeconds: 0, endSeconds: 2.1, text: 'Stick around.' }],
  },
];

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage');

createRoot(stage).render(
  <StitchedPlayer
    clips={clips}
    musicUrl={media('music.mp3')}
    musicGainDb={0}
    musicEnabled
  />
);
