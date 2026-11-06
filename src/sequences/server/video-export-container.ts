/**
 * Durable Object that fronts the video-export Cloudflare Container
 * (`containers/video-export` — Node + @mediabunny/server). It stitches a
 * sequence's scene MP4s and mixes music/dialogue for the public API export
 * (#968).
 *
 * Wiring (PRODUCTION ONLY — see wrangler.jsonc `[env.production]`):
 *   - `containers[]`            → builds the image from the Dockerfile
 *   - `durable_objects.bindings`→ `VIDEO_EXPORT_CONTAINER`
 *   - `migrations` tag `v2`     → registers this SQLite-backed DO class
 *   - re-exported from `src/server.ts` so the class lands in the Worker bundle
 *
 * The container is declared in production only so `bun dev` and hermetic e2e
 * need no Docker; `SequenceExportWorkflow` tolerates the binding's absence.
 *
 * `getContainer(env.VIDEO_EXPORT_CONTAINER, exportId)` routes a per-export
 * instance, then `.fetch('/export', …)` proxies to the container's HTTP server
 * (see `containers/video-export/src/server.ts`). Uploaded audio uses the same
 * server at `POST /transcode-audio` on one shared instance (`audio-transcode`).
 */

import { Container } from '@cloudflare/containers';

export class VideoExportContainer extends Container {
  // Matches `EXPOSE 8080` / `PORT=8080` in the container image.
  override defaultPort = 8080;

  // A render takes seconds-to-minutes; keep the instance warm briefly so a
  // burst of exports for one sequence reuses it, then scale to zero.
  override sleepAfter = '5m';
}
