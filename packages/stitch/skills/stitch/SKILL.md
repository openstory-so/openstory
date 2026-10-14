---
name: stitch
description: Play local stills, dialogue, music, and video as one sequence in the browser with the stitch command. Use when the user runs /stitch, or asks to stitch, preview, or play a cut from local image, audio, and video files.
user-invocable: true
argument-hint: '[--music file] [--subs file.srt] <image-or-video> [--audio file] [--seconds n] [--cue start-end text]...'
metadata:
  opencode/slash: 'true'
---

# stitch

`/stitch` runs the `stitch` command and leaves it running. The page it opens is the player.

## Command

From the directory that holds the files, or with paths that reach them:

```sh
npx @openstory/stitch \
  --music score.mp3 --music-gain -3 \
  --subs lines.srt \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?" \
  shot.mp4 --poster board.png --cue 0-1.5 "Love that accent."
```

Leave that process running and give the user the URL it prints.

1. Put the stills and videos in play order.
2. A `.mp4`, `.webm`, or `.mov` is a video. Its dialogue is the audio inside the file. Do not pass `--audio` for a video.
3. A `.png`, `.jpg`, `.jpeg`, or `.webp` is a still. The command reads its width and height.
4. `--audio` adds a line to the still before it. Repeat it for another line. The still stays up for the longer of `--seconds` and that sound. `--seconds` defaults to 4.
5. `--cue START-END TEXT` is a subtitle on the clip before it. Quote the text. Times are seconds from the start of that clip.
6. `--subs lines.srt` (or `.vtt`) is one subtitle file for the whole cut. Times in the file are from the start of the first clip. A cue that crosses a cut is split onto both clips. Use this instead of one `--cue` per line when a file already exists.
7. `--poster` is the still shown on the video before it while the cut opens. `--fallback` is the picture tried when the still before it fails to load.
8. `--music` is the bed under the whole cut. `--music-gain` changes only that bed, in dB. It defaults to 0. The page can turn that bed off; dialogue stays.
9. Run that `npx` command and give the user the `http://127.0.0.1:` URL it prints. Leave the process running until they are done. `--no-open` skips opening a browser.

## Installing this command

Prefer the OpenStory plugin, which includes this skill plus `create-style` and `create-sequence`: `npx skills add openstory-so/skills`. Grok, Claude Code, Codex, and the ChatGPT desktop app install that repo as a marketplace plugin named OpenStory. If `/stitch` is missing, tell the user to install the plugin.

`npx @openstory/stitch skill` copies only this skill to `.agents/skills/stitch`. `--global` copies it to `~/.agents/skills/stitch`.

## Clips, when embedding the player

A video clip is `{ videoUrl, posterUrl, cues }`. It plays the audio inside the file.

A still is `{ imageUrl, fallbackImageUrl, durationSeconds, audioUrls, width, height, cues }`. `audioUrls` play back to back from the start of the still. The still lasts for the longer of that sound and `durationSeconds`.

`musicUrl` is a bed under the whole sequence. `musicGainDb` changes only that bed. Dialogue stays at its own level.

Video, music, and a still's `audioUrls` need an HTTP URL that answers `Range` with 206, or a `blob:` URL whose `fetch` does. A still's line may be a `data:` URL. The `stitch` command serves local files that way.
