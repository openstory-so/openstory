---
name: stitch
description: Play stills, dialogue, music, and video as one sequence in the browser with the stitch command. Use when the user runs /stitch, or asks to stitch, preview, or play a cut from local or remote (http(s) URL) image, audio, and video files.
user-invocable: true
argument-hint: '[--frame 9:16] [--music file] [--subs file.srt] <image-or-video> [--poster file] [--fallback file] [--audio file] [--seconds n] [--cue start-end text]...'
metadata:
  opencode/slash: 'true'
---

# stitch

`/stitch` runs the `stitch` command and leaves it running. The page it opens is the player.

## Command

From the directory that holds the files, with paths that reach them, or with `http(s)` URLs anywhere a file goes:

```sh
npx @openstory/stitch@latest \
  --frame 9:16 \
  --music score.mp3 --music-gain -3 \
  --subs lines.srt \
  shot.mp4 --poster board.png --cue 0-1.5 "Love that accent." \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?"
```

1. Put the stills and videos in play order. Each is a path or an `http(s)` URL. The command reads a URL itself and serves it to the page from its own origin, so a remote without CORS headers still plays and exports.
2. A `.mp4`, `.webm`, or `.mov` is a video. Its dialogue is the audio inside the file. Do not pass `--audio` for a video.
3. A `.png`, `.jpg`, `.jpeg`, or `.webp` is a still. The command reads its width and height.
4. `--audio` adds a line to the still before it. Repeat it for another line. The still stays up for the longer of `--seconds` and that sound. `--seconds` defaults to 4.
5. `--cue START-END TEXT` is a subtitle on the clip before it. Quote the text. Times are seconds from the start of that clip.
6. `--subs lines.srt` (or `.vtt`) is one subtitle file for the whole cut. Times in the file are from the start of the first clip. A cue that crosses a cut is split onto both clips. Use this instead of one `--cue` per line when a file already exists.
7. `--poster` is the still shown while the cut opens. It belongs on an opening video. `--fallback` is the picture tried when the still before it fails to load.
8. `--music` is the bed under the whole cut. `--music-gain` changes only that bed, in dB. It defaults to 0. The page can turn that bed off; dialogue stays.
9. `--frame 9:16` (or `1080x1920`) is the shape of the page. Give it when the shape is known: without it the command reads the first clip to find out. Every clip is fitted into that box.
10. Run that `npx` command and give the user the `http://127.0.0.1:` URL it prints. Leave the process running until they are done. `--no-open` skips opening a browser.

## Installing this command

Prefer the OpenStory plugin, which includes this skill plus `create-style` and `create-sequence`: `npx skills add openstory-so/skills`. Grok, Claude Code, Codex, and the ChatGPT desktop app install that repo as a marketplace plugin named OpenStory. If `/stitch` is missing, tell the user to install the plugin.

`npx @openstory/stitch@latest skill` copies this skill and the player contract into `.agents/skills/` and `.claude/skills/`. `--global` copies both trees into the home directory.

## Embedding the player

Wiring `StitchedPlayer`, a `PlaybackClip` list, music, or an MP4 export is the `stitch-player` skill. Read that skill before writing a clip list.
