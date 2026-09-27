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

## Server-side export (API)

Theatre Download/Copy and the public API both `POST /api/v1/sequences/$id/exports`. There is no in-browser encode. Overlay icons on the player; desktop also has an Export dropdown next to Copy script. Theatre playback does not use the export at all — see below.

- POST 200 = ready row for the current cut (hash computed server-side). POST 202 = reuse a live `processing` row, or reserve one and trigger `SequenceExportWorkflow`. GET `?wait=60s` long-polls. (`src/routes/api/v1/sequences.$id.exports.ts`)
- The workflow absolutizes scene/music URLs, POSTs to the video-export Cloudflare Container (`containers/video-export/`), streams the MP4 into R2, and flips the row to `ready`/`failed`. The container never touches D1.
- Uniform AVC transmuxes; mixed-res/codec is decode→letterbox→re-encode. Production and PR previews run `standard-4`.
- **Local:** `bun dev:all` runs `dev:bunny` and sets `VIDEO_EXPORT_DEV_URL`. Plain `bun dev` and e2e have no renderer — Download/Copy toast rather than encoding in the tab. Container details: `containers/video-export/README.md`.

### Theatre playback stitches in the tab (#1845)

The whole-sequence theatre never waits on an export and nothing is rendered for it: `SequencePlayerEngine` (`src/sequences/ui/theatre/playback.ts`) stitches the cut's clips on a canvas under the Video.js skin.

- **Opening reads headers only.** `ConcatenatedVideoSource.prepare` opens every clip concurrently for its duration, size and codec; the loading bar counts clips opened. The first frame is the opening clip's own, shown before the engine is up.
- **Clip bytes load as the playhead reaches them.** A scene's embedded sound is decoded when the playhead is in it or the scene before, never the whole cut before the first play; the first play waits only on its own scene. `prefetch` reads the next clip's first second so the cut is not a cold fetch.
- **A stall suspends the `AudioContext`.** Its clock is the playback clock, so suspending it holds the playhead, the music and every queued dialogue node together. The media adapter drops to `HAVE_CURRENT_DATA` and fires `waiting`, which is what the skin's buffering spinner reads; `playing` clears it (the surface counts only the first `playing` after a pause as a play).
- **The HLS playlist (#1623) is gone.** It only ever played a finished, untouched cut, which is rare, and its ingest remux had to hold a whole clip in Worker memory (the muxer cannot write the `moof` before it has every sample, and a generated clip is one fragment). Existing `<clip>.frag.mp4` / `.frag.json` sidecars in R2 are orphaned and harmless.
- **Download is the export.** The canvas button and the player overlay open one menu (`sequence-export-actions.tsx`): Download / Copy link when the current cut has a ready render, otherwise why not ("Not rendered yet", "Cut changed since last render") and "Render MP4 on server". The row carries no progress, so the button shows elapsed time. "Stop waiting" only stops polling; POSTing again rejoins the in-flight row.
