<p align="center">
  <img src="../../.github/openstory-logo.svg" alt="OpenStory" width="275" />
</p>

# @openstory/stitch-player

A player for AI filmmaking. Stills, dialogue, music and video go in as you make them, and the browser plays that list as one sequence. Nothing is encoded until you ask for a file.

https://github.com/user-attachments/assets/f5dce65f-b042-4e25-bbfe-7914d209b0f3

This is the player behind [OpenStory](https://openstory.so)'s theatre. A shot is often a storyboard still with a recorded line, then a rendered clip, with music under the whole cut. Each piece is decoded as the playhead reaches it ([mediabunny](https://mediabunny.dev) and WebCodecs) and drawn on one canvas. A video plays the sound in its file. A still plays its own line. Subtitles sit on the picture. The controls are [Video.js 10](https://videojs.org).

Swap a still for a clip when the clip exists. The sequence is the same list either way.

When the cut is done, the same stitch writes an MP4 in the browser: H.264 and AAC, through WebCodecs. There is no ffmpeg install and no encode process beside the tab. Playback only reads the clip under the playhead, so a long cut does not mean the whole film sitting in memory.

Give it `https` URLs, or `blob:` URLs of bytes the page already holds. The sequence plays the same online and offline.

## An animatic in forty lines

Three stills, recorded lines, a music bed, then one rendered clip.

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

`musicGainDb` turns the music down and leaves dialogue alone (`-6` here). Captions toggle with the button or `c`. **Download** encodes the cut in the browser and writes a `.vtt` beside it. The file streams to disk where `showSaveFilePicker` exists. The audio mix is held in memory either way.

## What's in the box

| Import                             | What                                                                                                                | Also install                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `@openstory/stitch-player`         | The engine: `SequencePlayerEngine`, `ConcatenatedVideoSource`, clip types, pure helpers.                            | nothing                                                   |
| `@openstory/stitch-player/videojs` | `StitchedSequenceMedia`, a [Video.js 10](https://videojs.org) custom media, so the Video.js skin drives the engine. | nothing at runtime (`@videojs/media` is a type-only peer) |
| `@openstory/stitch-player/react`   | `StitchedPlayer`: the canvas under Video.js's `NeutralVideoSkin`, with subtitles and the Download button.           | `react`, `@videojs/react`                                 |
| `@openstory/stitch-player/export`  | `exportSequence` and `downloadSequence`: the same stitch, encoded to MP4 in the browser.                            | nothing                                                   |

`mediabunny` is a dependency, so it installs with the package. The React peers are optional: `react` ^19 and `@videojs/react` ^10. `@videojs/media` is a type-only peer of the Video.js entry; `@videojs/react` brings it in for the React surface.

```sh
npm install @openstory/stitch-player
# for the React surface
npm install react @videojs/react
```

Built against [Video.js 10](https://videojs.org) (`^10.0.0`).

## Clips

A clip is a rendered video or a timed still. Clips play in array order.

```ts
import type { PlaybackClip } from '@openstory/stitch-player';

const clips: PlaybackClip[] = [
  // A rendered clip. Its embedded sound plays with it.
  // `posterUrl` is for a host to show while it waits. This package does not paint it.
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

- **Mixed sizes are fine.** The target frame is the bounding box of the video clips (or of every still, when there is no video). `meta.hasMixedResolutions` is the warning for that. Bars appear only when `meta.hasMixedAspectRatios` is set; same-ratio clips are scaled to fill.
- **Cue times are seconds from the start of their own clip.** The player places them with the measured clip starts, so a long clip moves the cues after it and they stay on their own clips.
- **A new array of the same clips is not a new sequence.** Identity is order plus the media (`playbackClipsKey`): for a video, `videoUrl` only; for a still, the image URLs, `audioUrls`, `durationSeconds`, `width`, and `height`. Cue text is not part of it, so a refetch that only changes wording never rebuilds the player. Pass the new list to `setSource` anyway: the open source copies the cues, and Download writes those.

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

// Or straight to a file the user picks, from a click. Streamed where
// `showSaveFilePicker` exists; otherwise a Blob. The mix is in memory either way.
button.onclick = () =>
  downloadSequence({
    clips,
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    filename: 'cut.mp4',
  });
```

The export runs the same stitching code, so the file matches the preview: same frames, same letterboxing, same mix. Video is H.264 and audio is AAC, in an MP4. A codec the browser cannot encode is an error; nothing is quietly swapped. Undecodable embedded audio and a still with no loaded picture also throw, even though playback continues (silent, or on a dark frame). Pass a player's `engine.source` as `source` to skip a second `prepare()` of video clips it has already opened (the Download button does this), with the player paused. Music is opened again. Clip bytes may be reread if they were evicted from the 16 MiB range cache.

## Video.js 10 only

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
const meta = await engine.prepare(); // throws if a video track or a still's dialogue cannot be decoded
await engine.play();
engine.pause();
await engine.seek(3.5);
engine.setMusicEnabled(false); // instant, no re-prepare
engine.dispose();
```

`cueTextAt(clips, meta.clipOffsetsSeconds, time)` gives the subtitle for a time if you draw your own, and `cuesToWebVTT(clips, meta.clipOffsetsSeconds)` the whole sidecar.

`logger` defaults to `console`. Pass one to hear a clip whose embedded sound will not decode, or music that was omitted (`meta.musicUndecodable`). URLs are fetched as given.

## How it stays light

- **Opening is concurrent.** Every clip is opened at once for its duration and size, then the first frame is read, so a twenty-clip cut is one round of header reads plus that frame, not twenty sequential opens. Stills decode their images during `prepare()`.
- **Reads are bounded range requests.** 64 KiB blocks. A faststart header is one request; read-ahead doubles up to 2 MiB while a clip plays. Up to 16 MiB is cached per source, so a short clip can sit entirely in memory. `locate()` walks the offset table, O(N) in the clip count.
- **Sound streams too.** Each clip's audio is decoded a second ahead of the playhead and dropped once played; the next clip's opening is fetched three seconds before the cut.
- **A stall holds everything together.** The audio clock is the playback clock, so a network stall suspends it, and the picture, the music and every queued line of dialogue pause and resume as one.

## Requirements

- **Playback and export need a browser:** WebCodecs and Web Audio. The modules import under Node, and `@openstory/stitch-player/react` is safe to import during server rendering (it loads Video.js only on the client).
- **Clip and audio servers must allow Range requests.** Cross-origin URLs also need CORS, a 206, and `Access-Control-Expose-Headers: Content-Range`. Same-origin URLs do not need CORS. A `blob:` URL works for video, music and dialogue when `fetch` answers `Range` with 206, which is how a page plays a cut from bytes it already has. A `data:` URL works for a still's line. Playback loads stills as images, which needs no CORS. Export and Picture-in-Picture read the canvas back, so a still from another origin without CORS taints the canvas and those two throw `SecurityError`.
- **Encoding (export only):** H.264 and AAC encoders, which Chrome, Edge, Safari 17+ and recent Firefox have.

## License

MIT
