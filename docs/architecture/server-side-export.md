# Server-side export (API)

Theatre Download/Copy and the public API both `POST /api/v1/sequences/$id/exports`. There is no in-browser encode. Playback is the live canvas stitch, or a matching ready MP4 (`sourceShotsHash`). Overlay icons on the player; desktop also has an Export dropdown next to Copy script.

- POST 200 = ready row for the current cut (hash computed server-side). POST 202 = reuse a live `processing` row, or reserve one and trigger `SequenceExportWorkflow`. GET `?wait=60s` long-polls. (`src/routes/api/v1/sequences.$id.exports.ts`)
- The workflow absolutizes scene/music URLs, POSTs to the video-export Cloudflare Container (`containers/video-export/`), streams the MP4 into R2, and flips the row to `ready`/`failed`. The container never touches D1.
- Uniform AVC transmuxes; mixed-res/codec is decode→letterbox→re-encode. Production and PR previews run `standard-4`.
- **Local:** `bun dev:all` runs `dev:bunny` and sets `VIDEO_EXPORT_DEV_URL`. Plain `bun dev` and e2e have no renderer — theatre toasts rather than encoding in the tab. Container details: `containers/video-export/README.md`.
