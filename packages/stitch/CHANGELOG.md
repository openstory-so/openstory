# @openstory/stitch

## 0.4.0

### Minor Changes

- d6f713e: Add `stitch pull` to download a sequence's files into a folder. Run it with `npx @openstory/stitch pull <sequenceId>` or `bunx @openstory/stitch pull <sequenceId>`.

## 0.3.1

### Patch Changes

- 1f04946: Each clip's sound, and a still's dialogue, is now decoded and played as one node at the track's own sample rate, in playback and in the MP4 export. Scheduling every decoded chunk on its own made the browser resample each one alone against a context at the music's or the device's rate, so dialogue crackled at every chunk boundary (#2170). A track that spans more than a second past its clip, or carries more than a second of gaps, is refused and reported instead of played.

## 0.3.0

### Minor Changes

- afabd49: The `stitch` command takes `http(s)` URLs anywhere a file goes. A URL is probed over the network and proxied through the local server with the browser's `Range`, so a remote without CORS headers still plays and exports.

  `--frame 9:16` (or `1080x1920`) sets the shape of the page. Without it only the first clip is read before the page opens; other videos are read only when `--subs` needs their lengths.

- 8f29900: Clips are downloaded whole, in order, one at a time, up to two past the clip under the playhead, and held in memory. `play()` resolves once the current clip is all here, and a stall at a cut clears once the next clip is, so a slow link waits once per clip for the clip's bytes instead of stop-and-go; music still streams. Clips outside that window are let go of. The `stitch` preview server answers only its own host and only GET and HEAD, types a remote file as media or opaque bytes, and `--music` / `--audio` take only `.wav`, `.mp3`, `.m4a`, or `.ogg`.
- 5ef4e19: `stitch bundle <dir> …` writes a self-contained folder: the player page, `cut.json`, and every file under `media/` (a URL is downloaded). The page reads its cut and media relative to itself, so the folder plays from any static host and sub-path.

  `stitch share …` uploads that bundle to OpenStory and prints a link anyone can watch. The first share signs in with a device code and keeps the key in `~/.openstory/stitch.json`; `--origin` picks the server.

### Patch Changes

- 9d5165f: Releases publish only after the repository's tests pass on the commit being released.

## 0.2.0

### Minor Changes

- 75e184b: Rename the package from @openstory/stitch-player. `npx @openstory/stitch` plays local stills and videos in the browser, and `stitch skill` installs the /stitch command plus the stitch-player contract into `.agents/skills` and `.claude/skills`. The preview frame is the canvas box of the clips, so a portrait cut fills the window as portrait. `--subs` takes one `.srt` or `.vtt` for the whole cut. The page shows a loading line, warns about silent or missing media and mixed resolutions, and has icon buttons for music and Download. The package README is also in Chinese, French, and Spanish.

### Patch Changes

- 97b8c0a: Hold a still for the longer of its shot and its dialogue, so a short recording no longer rushes the picture.
- 44a113a: The README opens its Skill section with `npx @openstory/stitch skill`, which installs `stitch` and `stitch-player` into `.agents/skills` and `.claude/skills`, and `--global` for the home directory.
