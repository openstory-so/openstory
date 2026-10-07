# @openstory/stitch-player

Play a list of video clips and stills as **one film**, in the browser, with music, dialogue and subtitles, and never encode anything until someone asks for a file.

This is the player behind [OpenStory](https://openstory.so)'s theatre. A cut there changes every few minutes while someone works on it: a shot gets regenerated, a line gets re-recorded, a still stands in for a clip that isn't rendered yet. Re-encoding an MP4 for each change would be slow and pointless. So the player stitches at play time instead: each clip is decoded with [mediabunny](https://mediabunny.dev) (WebCodecs) as the playhead reaches it and drawn onto one canvas, the music is mixed under it through Web Audio, each clip's own sound plays with it, and subtitles are drawn over the picture. A still with a recorded line plays the same as a finished clip. When you do want a file, the same code encodes one, in the browser.

## An animatic in forty lines

Three stills, recorded dialogue, a music bed, subtitles. Nothing is rendered up front; the browser plays it as a film.

```tsx
import { StitchedPlayer } from '@openstory/stitch-player/react';
import '@videojs/react/video/neutral-skin.css';

const still = (
  n: number,
  seconds: number,
  cues: { at: number; text: string }[]
) => ({
  imageUrl: `https://cdn.example/board/${n}.png`,
  fallbackImageUrl: null,
  durationSeconds: seconds, // used only when there is no sound
  audioUrls: [`https://cdn.example/board/${n}.wav`],
  width: 1920,
  height: 1080,
  cues: cues.map(({ at, text }, i, all) => ({
    startSeconds: at,
    endSeconds: all[i + 1]?.at ?? seconds,
    text,
  })),
});

const clips = [
  still(0, 4, [{ at: 0.2, text: 'Ann: Where were you?' }]),
  still(1, 3, [
    { at: 0.1, text: 'Bob: Out.' },
    { at: 1.4, text: 'Bob: Walking.' },
  ]),
  // A rendered shot drops in exactly like a still, with its own sound.
  {
    videoUrl: 'https://cdn.example/shots/3.mp4',
    posterUrl: 'https://cdn.example/board/3.png',
    cues: [],
  },
];

export const Animatic = () => (
  <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
    <StitchedPlayer
      clips={clips}
      musicUrl="https://cdn.example/score.mp3"
      musicGainDb={-6}
      musicEnabled
      download={{ filename: 'animatic.mp4' }}
    />
  </div>
);
```

What you get: Video.js's controls, a captions button that toggles the subtitles (or press `c`), the music ducked six dB under the voices, and a **Download** button that encodes the whole thing to an MP4 in the browser, with a `.vtt` sidecar, streamed straight to disk where the browser allows it. Swap a still for a rendered clip later and nothing else changes.

## What's in the box

| Import                             | What                                                                                                                | Also install              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `@openstory/stitch-player`         | The engine: `SequencePlayerEngine`, `ConcatenatedVideoSource`, clip types, pure helpers.                            | nothing                   |
| `@openstory/stitch-player/videojs` | `StitchedSequenceMedia`, a [Video.js 10](https://videojs.com) custom media, so the Video.js skin drives the engine. | `@videojs/react`          |
| `@openstory/stitch-player/react`   | `StitchedPlayer`: the canvas under Video.js's `NeutralVideoSkin`, with subtitles and the Download button.           | `react`, `@videojs/react` |
| `@openstory/stitch-player/export`  | `exportSequence` and `downloadSequence`: the same stitch, encoded to MP4 in the browser.                            | nothing                   |

`mediabunny` is a dependency, so it installs with the package. The React and Video.js peers are optional. `@videojs/media` is a type-only import of the Video.js entry, and `@videojs/react` brings it in.

```sh
npm install @openstory/stitch-player
# for the React surface
npm install react @videojs/react
```

Built against Video.js 10 (`^10.0.0`).

## Clips

A clip is a rendered video or a timed still. Clips play in array order.

```ts
import type { PlaybackClip } from '@openstory/stitch-player';

const clips: PlaybackClip[] = [
  // A rendered clip. Its embedded sound plays with it. The poster shows while the player opens.
  { videoUrl: '/shot-1.mp4', posterUrl: '/shot-1.jpg', cues: [] },
  // A still, held for as long as its sound runs (or `durationSeconds` when silent).
  {
    imageUrl: '/shot-2.png',
    fallbackImageUrl: null,
    durationSeconds: 4,
    audioUrls: ['/shot-2-dialogue.wav'],
    width: 1920,
    height: 1080,
    cues: [
      { startSeconds: 0.2, endSeconds: 1.6, text: 'Ann: Where were you?' },
    ],
  },
];
```

- **Mixed sizes are fine.** Clips are letterboxed into one frame; `meta.hasMixedResolutions` tells you when that happened so you can warn.
- **Cue times are seconds from the start of their own clip.** The player measures each clip's real length when it opens and places the cues on the stitched timeline itself, so a clip that came back a little long does not shift the subtitles after it.
- **A new array of the same clips is not a new sequence.** Identity is order plus media URLs (`playbackClipsKey`), so a refetch that only changes cue text never rebuilds the player.

## React

```tsx
import { StitchedPlayer } from '@openstory/stitch-player/react';

<StitchedPlayer
  clips={clips}
  musicUrl="/score.mp3"
  musicGainDb={-3}
  musicEnabled
  subtitles // showing by default when any clip has cues
  autoPlay={false}
  download={{ filename: 'cut.mp4', subtitles: 'sidecar' }}
  onMeta={(meta) => console.log(meta.durationSeconds, meta.clipOffsetsSeconds)}
  onTimeUpdate={(t) => {}}
  onPlay={() => {}}
  onPause={() => {}}
  onEnded={() => {}}
  onError={(reason) => console.error(reason)}
/>;
```

`StitchedPlayer` is safe to import anywhere, including a server render: it renders `fallback` (nothing by default) on the server and until its code has loaded on the client, then the player. The Video.js parts are loaded behind that, so your framework never evaluates them during SSR. Import the skin stylesheet once: `import '@videojs/react/video/neutral-skin.css'`.

Subtitles are drawn by the surface, not by a `<video>` element (there is none), in a box above the controls that lifts with them. Picture-in-Picture works too: the canvas is streamed into a hidden video and that is what floats. Restyle it with CSS on `[data-part="stitch-captions"]`; the Download button is `[data-part="stitch-download"]`.

## Export

```ts
import {
  exportSequence,
  downloadSequence,
} from '@openstory/stitch-player/export';

// A file in memory, plus the subtitles as WebVTT.
const { blob, vtt, durationSeconds } = await exportSequence({
  clips,
  musicUrl: '/score.mp3',
  musicGainDb: -3,
  musicEnabled: true,
  frameRate: 24, // the default; stills are sampled at this rate too
  subtitles: 'sidecar', // or 'burn-in' to draw them onto the frames, or 'none'
  onProgress: (fraction) => {},
  signal: controller.signal,
});

// Or straight to a file the user picks (streamed; nothing held in memory), from a click:
button.onclick = () =>
  downloadSequence({
    clips,
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    filename: 'cut.mp4',
  });
```

The export runs the same stitching code a second time, so the file matches the preview: same frames, same letterboxing, same mix. Video is H.264 and audio is AAC, in an MP4. A codec the browser cannot encode is an error; nothing is quietly swapped. Pass a player's `engine.source` as `source` to export from clips it has already opened (the Download button does this), with the player paused.

## Video.js only

```ts
import { StitchedSequenceMedia } from '@openstory/stitch-player/videojs';

const media = new StitchedSequenceMedia();
media.setListeners({ onError: console.error });
media.setSource({
  clips,
  musicUrl: null,
  musicGainDb: 0,
  musicEnabled: false,
  subtitles: true,
});
media.attach(canvas); // the engine draws into this HTMLCanvasElement
await media.play();
media.currentTime = 12; // seeks
media.textTracks; // one `subtitles` track when any clip has cues; the skin's captions button toggles it
media.activeCueText; // the subtitle at the playhead, or null
```

## Engine only

```ts
import { SequencePlayerEngine } from '@openstory/stitch-player';

const engine = new SequencePlayerEngine({
  canvas,
  clips,
  musicUrl: null,
  musicGainDb: 0,
  musicEnabled: false,
  onTimeUpdate: (t) => {},
  onBuffering: (stalled) => {},
  onEnded: () => {},
  onError: console.error,
});
const meta = await engine.prepare(); // opens every clip's header; throws if a codec cannot be decoded
await engine.play();
engine.pause();
await engine.seek(3.5);
engine.setMusicEnabled(false); // instant, no re-prepare
engine.dispose();
```

`cueTextAt(clips, meta.clipOffsetsSeconds, time)` gives the subtitle for a time if you draw your own, and `cuesToWebVTT(clips, meta.clipOffsetsSeconds)` the whole sidecar.

## How it stays light

- **Opening reads headers only.** Every clip is opened concurrently for its duration and size, so a twenty-clip cut shows its first frame after one round trip, not twenty.
- **Reads are bounded range requests.** 64 KiB blocks, one request per clip header, and a read-ahead that only grows while a clip is actually playing, up to 2 MiB. A whole clip never sits in memory.
- **Sound streams too.** Each clip's audio is decoded a second ahead of the playhead and dropped once played; the next clip's opening is fetched three seconds before the cut.
- **A stall holds everything together.** The audio clock is the playback clock, so a network stall suspends it, and the picture, the music and every queued line of dialogue pause and resume as one.

## Requirements

- **Browser only.** WebCodecs and Web Audio. Nothing here runs in Node or on an edge runtime.
- **Clip and audio servers must allow Range requests and CORS.** The engine reads clips in range requests. A `data:` or `blob:` URL works for a still's sound. Playback loads stills as images, which needs no CORS. Export and Picture-in-Picture read the canvas back, so a still from another origin without CORS taints the canvas and those two throw `SecurityError`.
- **Encoding (export only):** H.264 and AAC encoders, which Chrome, Edge, Safari 17+ and recent Firefox have.

## License

MIT
