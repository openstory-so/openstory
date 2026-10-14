---
name: stitch
description: Play local stills, dialogue, music, and video as one sequence in the browser with the stitch command. Use when the user runs /stitch, or asks to stitch, preview, or play a cut from local image, audio, and video files.
user-invocable: true
argument-hint: '[--music file] <image-or-video> [--audio file] [--seconds n] [--cue start-end text]...'
metadata:
  opencode/slash: 'true'
---

# stitch

`/stitch` runs the `stitch` command and leaves it running. The page it opens is the player.

## Command

From the directory that holds the files, or with paths that reach them:

```sh
stitch \
  --music score.mp3 --music-gain -3 \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?" \
  shot.mp4 --cue 0-1.5 "Love that accent."
```

`npx @openstory/stitch` is the same command when `stitch` is not installed.

1. Put the stills and videos in play order.
2. A `.mp4`, `.webm`, or `.mov` is a video. Its dialogue is the audio inside the file. Do not pass `--audio` for a video.
3. A `.png`, `.jpg`, `.jpeg`, or `.webp` is a still. The command reads its width and height.
4. `--audio` adds a line to the still before it. Repeat it for another line. The still stays up for the longer of `--seconds` and that sound. `--seconds` defaults to 4.
5. `--cue START-END TEXT` is a subtitle on the clip before it. Quote the text. Times are seconds from the start of that clip.
6. `--music` is the bed under the whole cut. `--music-gain` changes only that bed, in dB. It defaults to 0.
7. Run it and give the user the `http://127.0.0.1:` URL it prints. Leave the process running until they are done. `--no-open` skips opening a browser.

## Installing this command

`stitch skill` copies this directory to `.agents/skills/stitch`. `stitch skill --global` copies it to `~/.agents/skills/stitch`. Agents that read that folder list it as `/stitch` because the `name` is `stitch`.

## Clips, when embedding the player

A video clip is `{ videoUrl, posterUrl, cues }`. It plays the audio inside the file.

A still is `{ imageUrl, fallbackImageUrl, durationSeconds, audioUrls, width, height, cues }`. `audioUrls` play back to back from the start of the still. The still lasts for the longer of that sound and `durationSeconds`.

`musicUrl` is a bed under the whole sequence. `musicGainDb` changes only that bed. Dialogue stays at its own level.

Video, music, and a still's `audioUrls` need an HTTP URL that answers `Range` with 206, or a `blob:` URL whose `fetch` does. A still's line may be a `data:` URL. The `stitch` command serves local files that way.
