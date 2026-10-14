---
name: stitch-player
description: Use when wiring @openstory/stitch, building a PlaybackClip list of stills, dialogue, music and video, or exporting that sequence to an MP4. Covers which sound belongs on a clip, how long a still holds, how music is mixed, and which URLs the player can read.
---

# stitch-player

Play `PlaybackClip[]` in order with `StitchedPlayer` from `@openstory/stitch/react`. The package README (`node_modules/@openstory/stitch/README.md`) has the install and the component example. This file is the contract that example leaves easy to miss.

## Clips

A video clip is `{ videoUrl, posterUrl, cues }`. It plays the audio inside the file.

A still is `{ imageUrl, fallbackImageUrl, durationSeconds, audioUrls, width, height, cues }`. `audioUrls` play back to back from the start of the still. The still lasts the longer of that sound and `durationSeconds`. `width` and `height` are the still's pixel size. `durationSeconds` stays positive even when the sound is longer.

`posterUrl` is for a host to show while it waits. The engine and `StitchedPlayer` do not paint it.

Cue times are seconds from the start of that clip.

Pass the new array through when the list changes. Identity is order plus the media (`playbackClipsKey`): for a video, `videoUrl` only; for a still, the image URLs, `audioUrls`, `durationSeconds`, `width`, and `height`. Cue text is outside that identity, so a wording-only change leaves the engine running. Download writes the cues on the array you passed.

## Music

`musicUrl` is a bed under the whole sequence. `musicGainDb` changes only that bed. `0` leaves it as recorded. `musicEnabled: false` mutes the bed. Dialogue stays at its own level.

## Bytes

Video, music, and a still's `audioUrls` need an HTTP URL that answers `Range` with 206, or a `blob:` URL whose `fetch` does. A still's line may be a `data:` URL.

A cross-origin still with no CORS still displays. Export and picture-in-picture read the canvas, so that still taints it and those two throw `SecurityError`.

## The file

The MP4 comes from `exportSequence`, `downloadSequence`, or the player's Download button. It is the same stitch as playback: H.264 and AAC. `subtitles` is `sidecar` (a `.vtt` beside the file), `burn-in`, or `none`. The default is `sidecar`.

Encode in the page.
