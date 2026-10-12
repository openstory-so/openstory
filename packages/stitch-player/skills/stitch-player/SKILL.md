---
name: stitch-player
description: Use when wiring @openstory/stitch-player, playing a sequence of stills, dialogue, music and video in the browser, or exporting that sequence to an MP4. Covers which sound belongs on a clip, how music is mixed, and which URLs the player can read.
---

# stitch-player

Play `PlaybackClip[]` in order. The README in this package has the install and the component example. This file is the contract that example leaves easy to miss.

## Clips

A video clip is `{ videoUrl, posterUrl, cues }`. It plays the audio inside the file.

A still is `{ imageUrl, fallbackImageUrl, durationSeconds, audioUrls, width, height, cues }`. `audioUrls` play back to back, and the still lasts as long as that sound. `durationSeconds` is the length only when `audioUrls` is empty. `width` and `height` are the still's pixel size.

`posterUrl` is for a host to show while it waits. This package does not paint it.

Cue times are seconds from the start of that clip.

Replacing a still with a video is a new entry in the same list. Pass the new array through. Cue text is not part of clip identity, so a wording-only change still has to be passed to `setSource` or it will not be what Download writes.

## Music

`musicUrl` is a bed under the whole sequence. `musicGainDb` changes only that bed. `0` leaves it as recorded. Dialogue stays at its own level.

## Bytes

Video, music, and a still's `audioUrls` need an HTTP URL that answers `Range` with 206, or a `blob:` URL whose `fetch` does. A still's line may be a `data:` URL.

A cross-origin still with no CORS still displays. Export and picture-in-picture read the canvas, so that still taints it and those two throw `SecurityError`.

## The file

The MP4 comes from `exportSequence`, `downloadSequence`, or the player's Download button. It is the same stitch as playback: H.264 and AAC. `subtitles` is `sidecar` (a `.vtt` beside the file), `burn-in`, or `none`.

Encode in the page. The default `subtitles` value is `sidecar`.
