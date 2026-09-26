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

### Theatre playback is a playlist of the clips (#1623)

The whole-sequence theatre plays `GET /api/sequences/$id/theatre.m3u8`: an HLS list that points straight at the cut's own clips, one after another. Nothing is rendered and no container is involved, so the first frame, the full length and every seek target are there as soon as the list loads. A shot or scene selection, and any failure, plays the in-tab canvas stitch. (`src/sequences/server/theatre-playlist.ts`, `src/routes/api/sequences.$id.theatre[.]m3u8.ts`)

- **Each clip gets a fragmented copy, once, at ingest.** HLS cannot point at a plain MP4 (`moov` + one `mdat`), which is how clips are stored. `uploadVideoFromUrl` and a user shot-video finalize write `<clip>.frag.mp4` beside the original — the same packets repackaged, nothing decoded — then `<clip>.frag.json` (init length, size, duration, codec, has-audio). The sidecar is written last; its presence says the copy is whole. The remux reads ranged bytes from R2 (`CustomSource`) and streams the copy out through `uploadResponse` + `FixedLengthStream`; a clip is never fully resident (#1735). `GET theatre.m3u8` only reads sidecars. A missing sidecar (an older clip, or a copy that failed) 400s and the theatre stitches. So the copy is best-effort (`tryWriteFragmentedCopy`): a failed remux or R2 put is logged, never fails the ingest of a rendered, billed clip. Studio clips never play in the theatre and skip it (`theatreCopy: false`).
- **Packets are copied by hand, not through mediabunny's `Conversion`.** An AAC track starts one frame before zero (encoder priming); `Conversion` trims that by re-encoding, and workerd has no codec. The early packets are dropped instead.
- **One segment per clip**, as a byte range behind its own `EXT-X-MAP`, with `EXT-X-DISCONTINUITY` between clips (each clip's clock starts at 0; resolutions may differ). Generated clips usually carry one key frame, so nothing finer is possible — the first frame waits for the first clip to download.
- **A list one player cannot append is refused** (400): clips that differ in video codec, or where only some have an audio track. So is a clip whose URL is not an `/r2/` key (legacy absolute rows). The theatre stitches instead.
- **Asked for early.** `useSequenceExport` fetches the playlist as soon as the shots are known. The URL carries a hash of the clip list: a changed cut is a new URL.
- **Music plays alongside** in an `<audio>` element that follows the video (`use-theatre-music.ts`) — HLS cannot mix a second audio track in. Toggling it is live; nothing reloads. It plays at the file's own level, as the stitcher does; only the exported MP4 is loudness-normalised.
- **hls.js is attached to the plain `<Video>` element** (`video-player-surface.tsx`) and loads only for an `.m3u8` source. A fatal error falls back to the stitcher for that URL.
- **The wait shows the first clip's first frame**, not a grey box (`sequence-player.tsx`). It stays up until the source has loaded, which is also when `data-state` turns `ready`.
- The copies double a clip's storage and are not yet removed when a clip is deleted.
