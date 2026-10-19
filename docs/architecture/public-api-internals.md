# Public API internals: the OpenAPI document and server-side export

How two pieces behind `/api/v1` are built. The user-facing guide is `docs/developer-guide/public-api.md` (published on the site — keep internals out of it).

## Public API OpenAPI document

`GET /api/v1/openapi.json` is built by `src/platform/server/api-v1/openapi.ts`, and **every
schema in it is generated** — nothing is hand-authored. Request bodies come
from the validators the routes parse with; response documents come from the
Zod schemas their TypeScript types are `z.infer`'d from (`state.ts`,
`create.ts`, `list.ts`, `styles.ts`, `hal.ts`). So a response shape cannot
drift from its published contract: change the schema and both move together.

- A component is named by `.meta({ id })`; `componentDefs()` hoists the `$defs`
  Zod emits into `components.schemas` and repoints the refs.
- **`.extend()` mints a new schema and drops the `.meta({ id })`.** Tag the
  shape you actually return — the `_links`-bearing _resource_
  (`sequenceStateResourceSchema`, `styleResourceSchema`), not the bare body —
  or the component is published but never referenced.
- `openapi.test.ts` fails on any dangling `$ref`, which is what caught that.
- Use `z.string().meta({ format: 'date-time' })`, not `z.iso.datetime()`: the
  latter also publishes a multi-hundred-character regex.

## Create and Continue take what the app sends (#2084)

`POST /api/v1/sequences` and the MCP `create_sequence` share
`apiCreateSequenceSchema`; a create from either is the sequence the composer
would make from the same choices.

- **Same default model as the app (#2088).** A request that names no `videoModels` starts on
  Seedance 2.5 where the team reaches BytePlus and on `DEFAULT_VIDEO_MODEL` elsewhere
  (`resolveApiVideoDefaults`, asked the way `getViaAvailabilityFn` asks). `draftMotion` is kept
  only on that route, as the composer does; `POST /scripts/enhance` shapes the script for the
  same model.
- **Same defaults as the app.** `startFrames` is off, `draftMotion` is on, and with no `stopAt` and
  no `motion` the run stops at `NEW_SEQUENCE_STOP_AT` (dialogue), the
  composer's own default (`apiStopAt`). It used to stop at images with start
  frames forced on. Stopping at images with start frames off makes sheets and
  no stills, so do not move the default stop back without turning neither on.
- **Continue.** `plan_generation` with `mode: "missing"` takes `startFrames`
  and `draftMotion` beside `stopAt`. They ride the plan token, the plan and its
  digest are computed under them, and they are saved on the sequence only at
  `execute_generation`, through `withContinueSwitches`, the same save and
  restore the Continue footer uses.
- **Voices are not a field** on either (#2067).
- **`ui-settings-parity.test.ts` pins it.** Its two maps are typed against
  `GenerationSettings` and `ContinueFlags`. A new composer setting or Continue
  switch needs an API field there, or a stated reason it has none.

## Server-side export (API)

Theatre Download/Copy and the public API both `POST /api/v1/sequences/$id/exports`. There is no in-browser encode. Overlay icons on the player; desktop also has an Export dropdown next to Copy script. Theatre playback does not use the export at all — see below.

- POST 200 = ready row for the current cut (hash computed server-side). POST 202 = reuse a live `processing` row, or reserve one and trigger `SequenceExportWorkflow`. GET `?wait=60s` long-polls. (`src/routes/api/v1/sequences.$id.exports.ts`) The route is an adapter: `resolveExportCut` / `startExport` in `src/sequences/server/export.ts` (#1461) are the one operation, shared with MCP `plan_export` / `start_export`. A trigger that throws marks its new row `failed` at once, freeing the one-processing-row slot.
- The workflow absolutizes scene/music URLs, POSTs to the video-export Cloudflare Container (`containers/video-export/`), streams the MP4 into R2, and flips the row to `ready`/`failed`. The container never touches D1.
- Uniform AVC transmuxes; mixed-res/codec is decode→letterbox→re-encode. Production and PR previews run `standard-4`.
- **Local:** `bun dev:all` runs `dev:bunny` and sets `VIDEO_EXPORT_DEV_URL`. Plain `bun dev` and e2e have no renderer — Download/Copy toast rather than encoding in the tab. Container details: `containers/video-export/README.md`.

### Shared stitches (#2127)

A cut made with the stitch CLI can be watched by anyone without the CLI. `stitch bundle <dir> …` writes a folder: the player page, `cut.json`, and every file under `media/<n>.<ext>` (a URL is downloaded, so a signed URL is snapshotted). The page reads `cut.json` and the media relative to itself (`base: './'`), so the folder plays from any static host and sub-path. `stitch share …` uploads the same bundle to OpenStory and prints a link.

- **Sign-in is the device code.** The first `share` POSTs `/api/v1/device/code`, opens the approval page, polls `/api/v1/device/token?wait=60s`, and keeps the `osk_` key in `~/.openstory/stitch.json` under its origin (`--origin` picks the server). A 401 on a stored key signs in once more, then stops. The sign-in URL must be on that origin before it reaches the OS launcher.
- **One POST, then one PUT per file.** `POST /api/v1/stitches` (`src/routes/api/v1/stitches.ts`) takes `{ cut }` where every media URL is a bundle name (`stitchCutSchema`, `src/stitches/cut.ts`); anything else, a URL or a `..`, is a 400. The row (`stitches`: id, team, user, cut, created) stores the cut with each name rewritten to `/r2/stitches/<teamId>/<id>/<n>.<ext>` (`storedStitchCut`), so a stored cut can only point at files the team uploaded. The 201 carries `url` and a templated `upload` link to the ordinary `/api/storage/upload?bucket=stitches&path=<teamId>/<id>/{name}&contentType={type}`, which `resolveUploadTarget` already checks against the team on the path, and a `publish` link. The row is born unpublished (`publishedAt` null), and the page 404s until then.
- **Publish is the real-person check for the CLI path.** After the last PUT the CLI POSTs `/api/v1/stitches/$id/publish` (`src/routes/api/v1/stitches.$id.publish.ts` over `publishStitch`, `src/stitches/server/publish-stitch.ts`). It refuses unless every file the cut names is in the bucket (`fileExists`, naming the missing one), then runs `classifyUpload` on every image, the same gate `storeUpload` runs; a real person needs `portraitAttestation` in the body (`stitch share --portrait-rights <basis>`), recorded with `attestUploads`. Only then is `publishedAt` set. The raw upload route stores whatever bytes arrive, so without this step a still would reach a public page unchecked. A stitch file is written once: `resolveUploadTarget` 409s a PUT over an object that is already in the `stitches` bucket, so a checked still cannot be swapped on a live page. The cut's name pattern allows only the player's extensions (`STITCH_EXTENSIONS`, pinned equal to `UPLOAD_EXTENSIONS`), and the CLI refuses an extension-less or unknown file before the POST.
- **`create_stitch` on MCP** (`src/platform/server/mcp/tools/stitch.ts` over `createStitchFromSources`, `src/stitches/server/create-stitch.ts`) is the same share with no CLI: each slot of the cut is `{ url }` or `{ data, mimeType }` (`stitchSourcesCutSchema`, the cut schema parameterised by `cutSchemaOf`). Every distinct source is stored once through `storeUpload` with `use: 'stitch'` under `stitches/<team>/<id>/` (the same fetch guard, size caps and real-person check as `upload_media`; `stitch` is a store use only, not on `upload_media`'s enum), its media type is checked against the slot's role, and the row is written with the stored URLs, published at once.
- **The page is public.** `/stitch/$id` (`src/routes/stitch/$id.tsx`) loads the cut through `getStitchFn`, an unauthenticated server fn over `getPublicStitch` in the composition root, which reads published rows only; the ULID is the only credential, as for a stored media URL. It renders `StitchedPlayer` with a music switch and Download, and shows a player failure in the box with a retry. Media is `/r2/...`, which redirects to the storage domain, whose CORS allows the app origin.
- **Social preview (#2140).** The page's `head` sets Open Graph and Twitter tags from `getStitchFn`: `og:image` is the cut's opening picture (`openingPicture`, `src/stitches/cut.ts`: the first clip's poster, else its still, else that still's fallback) made absolute with `toShareableUrl`, typed from its extension and sized as the frame. A first clip that is a video with no poster has no picture, and the site's own card stays; no later picture is used instead.
- **Shared from a sequence (#2140).** "Share stitch link" in the sequence's Download menu calls `shareSequenceStitchFn` (`src/stitches/stitch.fn.ts`). The server builds the cut the theatre plays from the team's own shots (`loadShotViews`, the loader `getShotsFn` returns, then `toPlaybackClips`), with the music when it is on, and writes it published. No URL comes from the browser, so the row points only at the team's media, and it needs no render. Like "Copy link" on a render, the cut is public by its id; it is a snapshot, so a later edit to the sequence needs a new share.
- **Not yet:** listing or deleting a share, an expiry, a publish-only retry (a share refused at publish, say for a missing `--portrait-rights`, is run again from the start, which mints a new row and leaves the first row and its files behind unpublished), and a per-request size past the single-upload ~100 MB (the CLI reads each file whole; the multipart route is the step up).

### Theatre playback stitches in the tab (#1845)

The whole-sequence theatre never waits on an export and nothing is rendered for it: `SequencePlayerEngine` stitches the cut's clips on a canvas under the Video.js skin. The player is the workspace package `@openstory/stitch` (`packages/stitch`, #1853): the engine, a Video.js media adapter (`/videojs`) and the React surface (`/react`), none of which know about shots. The app resolves it from source through a tsconfig path, so no build step runs in dev; `bun run --cwd packages/stitch build` emits `dist/` for publishing. `npx @openstory/stitch` serves local stills, videos and audio to a page built from this player (`dist/page`). The page reads `frameWidth` and `frameHeight` from `/cut.json` and fits that box in the window before the player opens. Those numbers are the canvas size: videos own the box, and a still-only cut uses the stills. `--subs` reads one `.srt` or `.vtt` on the whole-cut timeline and stores each cue on the clip that contains it, splitting a cue that crosses a cut. The page turns music on and off, shows the opening frame while headers load, and uses the same gap and mixed-resolution warnings as the theatre. `stitch skill` copies the `stitch` (`/stitch`) and `stitch-player` skills into `.agents/skills` and `.claude/skills`. What stays in `src/sequences/ui/theatre/` is OpenStory's: `sequence-player.tsx` (shadcn chrome, PostHog), `playback-clips.ts` (shots → `PlaybackClip`s), the export client and analytics.

- **Subtitles are drawn by the surface, not encoded.** Each `PlaybackClip` carries `cues` in clip-local seconds (`shotCues`: a shot's lines, timed by `ShotView.dialogueTiming`, which is derived on read from the selected reading's speech, else every line over the whole shot). The media exposes one `subtitles` text track when any clip has cues, so the skin's captions button and `c` toggle it; there is no `<video>` to paint cues, so `StitchedPlayerSurface` renders `media.activeCueText` in a layer that lifts with the controls via the skin's `--media-caption-track-y`. Cue changes never rebuild the engine (`playbackClipsKey` ignores them). The server render does not burn them in. The shot player is a normal `<video>`. It points a captions `<track>` at `GET /api/sequences/$sequenceId/shots/$shotId/subtitles` (`text/vtt`, `loadShotSubtitlesVtt`, the same `shotVideoSubtitlesVtt` cues). A `data:` URL is a different origin and Chrome refuses it. `?v=` changes when the text changes. That skin does not paint the cue, so `video-player-surface.tsx` draws the showing track's active cue in the same caption layer as the sequence player. A still has no `<video>`, so that player shows no captions. The skin shows a control only when the media can do the thing: Picture-in-Picture is there (the canvas is captured into a hidden `<video>`, redrawn onto itself first so a paused player has a frame to float); Cast is not and cannot be, since a stitched cut has no URL a device could fetch. Both players share `playerFrameClassName`, and `global.css` sets `.media-skin`'s own frame border to transparent so it is not a second border.
- **The package can also export in the browser** (`@openstory/stitch/export`, `exportSequence`): the same frames sampled at 24 fps by default (`frameRate` overrides it; a still is re-added each tick), the same mix rendered through an `OfflineAudioContext`, encoded with WebCodecs to an MP4, streamed to a `FileSystemWritableFileStream` or returned as a `Blob`; subtitles as a WebVTT sidecar (`cuesToWebVTT`) by default, or burned in. A codec the browser cannot encode is an error. `downloadSequence` wraps it for a click (`showSaveFilePicker` streams to disk where it exists, else a download), and `StitchedPlayer`'s `download` prop puts a button on the player that pauses and exports from the engine's own opened source (`engine.source`), so video clips are not probed again. Music is opened again. Clip bytes may be reread if they fell out of the 16 MiB range cache. A cue-only update is copied onto that source, so the file's subtitles match the ones on screen. OpenStory does not use it — the server render stays the product's export — but the `Export*` and `WithDownload` stories exercise it.

- **Opening reads headers only.** `ConcatenatedVideoSource.prepare` opens every clip concurrently for its duration, size and codec; the loading bar counts clips opened. While it runs, the opening shot's still (`posterUrl`) covers the player — never a hidden `<video>`, which downloads the clip beside the stitcher's own reads.
- **Reads are bounded range requests** (`ranged-source.ts`). Mediabunny's `UrlSource` opens each file with an open-ended request and a 512 KiB read-ahead: ~10 MB for a 20-clip cut whose headers are ~20 KB. `createRangedSource` reads 64 KiB blocks — one request per faststart header — and doubles the read-ahead (to 2 MiB) only while reads stay sequential, i.e. a clip playing. Clips, stills' takes and the music all go through it.
- **Sound streams, like the music.** Each scene's embedded sound is an `AudioBufferSink` iterated a second ahead of the playhead (the "scene-sound lane"), never decoded whole before a play — decoding a clip's sound means downloading the clip, because audio is interleaved through it. `prefetch` reads the next clip's first second, three seconds before the cut.
- **Measured (20 clips, 2:30, cache off, Chrome network emulation).** Fast 4G: first frame 6 s, moving 2.4 s after play, 1 s of spinner over the next minute; the old engine showed its first frame at 17 s and had not started 60 s after play (it decoded every scene's sound first, 64 MB). Slow 4G: first frame 31 s, moving 13 s after play, then stalls — these clips run ~11 Mbit/s against a 1.4 Mbit/s link; the old engine showed no frame in 4 minutes.
- **A stall suspends the `AudioContext`.** Its clock is the playback clock, so suspending it holds the playhead, the music and every queued dialogue node together. The media adapter drops to `HAVE_CURRENT_DATA` and fires `waiting`, which is what the skin's buffering spinner reads; `playing` clears it (the surface counts only the first `playing` after a pause as a play).
- **The HLS playlist (#1623) is gone.** It only ever played a finished, untouched cut, which is rare, and its ingest remux had to hold a whole clip in Worker memory (the muxer cannot write the `moof` before it has every sample, and a generated clip is one fragment). Existing `<clip>.frag.mp4` / `.frag.json` sidecars in R2 are orphaned and harmless.
- **Download is the export.** The canvas button and the player overlay open one menu (`sequence-export-actions.tsx`): Download / Copy link when the current cut has a ready render, otherwise why not ("Not rendered yet", "Cut changed since last render") and "Render MP4 on server". The row carries no progress, so the button shows elapsed time. "Stop waiting" only stops polling; POSTing again rejoins the in-flight row.
