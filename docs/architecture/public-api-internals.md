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

- **Same defaults as the app.** `startFrames` is off, and with no `stopAt` and
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

### Theatre playback stitches in the tab (#1845)

The whole-sequence theatre never waits on an export and nothing is rendered for it: `SequencePlayerEngine` (`src/sequences/ui/theatre/playback.ts`) stitches the cut's clips on a canvas under the Video.js skin.

- **Opening reads headers only.** `ConcatenatedVideoSource.prepare` opens every clip concurrently for its duration, size and codec; the loading bar counts clips opened. While it runs, the opening shot's still (`posterUrl`) covers the player — never a hidden `<video>`, which downloads the clip beside the stitcher's own reads.
- **Reads are bounded range requests** (`ranged-source.ts`). Mediabunny's `UrlSource` opens each file with an open-ended request and a 512 KiB read-ahead: ~10 MB for a 20-clip cut whose headers are ~20 KB. `createRangedSource` reads 64 KiB blocks — one request per faststart header — and doubles the read-ahead (to 2 MiB) only while reads stay sequential, i.e. a clip playing. Clips, stills' takes and the music all go through it.
- **Sound streams, like the music.** Each scene's embedded sound is an `AudioBufferSink` iterated a second ahead of the playhead (the "scene-sound lane"), never decoded whole before a play — decoding a clip's sound means downloading the clip, because audio is interleaved through it. `prefetch` reads the next clip's first second, three seconds before the cut.
- **Measured (20 clips, 2:30, cache off, Chrome network emulation).** Fast 4G: first frame 6 s, moving 2.4 s after play, 1 s of spinner over the next minute; the old engine showed its first frame at 17 s and had not started 60 s after play (it decoded every scene's sound first, 64 MB). Slow 4G: first frame 31 s, moving 13 s after play, then stalls — these clips run ~11 Mbit/s against a 1.4 Mbit/s link; the old engine showed no frame in 4 minutes.
- **A stall suspends the `AudioContext`.** Its clock is the playback clock, so suspending it holds the playhead, the music and every queued dialogue node together. The media adapter drops to `HAVE_CURRENT_DATA` and fires `waiting`, which is what the skin's buffering spinner reads; `playing` clears it (the surface counts only the first `playing` after a pause as a play).
- **The HLS playlist (#1623) is gone.** It only ever played a finished, untouched cut, which is rare, and its ingest remux had to hold a whole clip in Worker memory (the muxer cannot write the `moof` before it has every sample, and a generated clip is one fragment). Existing `<clip>.frag.mp4` / `.frag.json` sidecars in R2 are orphaned and harmless.
- **Download is the export.** The canvas button and the player overlay open one menu (`sequence-export-actions.tsx`): Download / Copy link when the current cut has a ready render, otherwise why not ("Not rendered yet", "Cut changed since last render") and "Render MP4 on server". The row carries no progress, so the button shows elapsed time. "Stop waiting" only stops polling; POSTing again rejoins the in-flight row.
