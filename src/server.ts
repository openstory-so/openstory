/**
 * Custom TanStack Start server entry.
 *
 * `./instrumentation` is imported first so OpenTelemetry is active before
 * the default handler's transitive route / server-function graph loads.
 */

import './instrumentation';
import handler from '@tanstack/react-start/server-entry';
import {
  acceptsMarkdown,
  getMarkdownForPath,
  markdownResponse,
  withDiscoveryLinkHeader,
  withHtmlAccept,
} from '@/platform/server/agent/discovery';
import { reconcileAllStuckJobs } from '@/platform/server/cron/reconcile-all';
import {
  FAL_PRICING_CRON,
  refreshFalPricing,
} from '@/billing/server/refresh-fal-pricing';
import {
  FAL_BILLING_RECONCILE_CRON,
  reconcileFalBilling,
} from '@/billing/server/reconcile-fal-billing';
import {
  BYTEPLUS_ASSETS_RECONCILE_CRON,
  reconcileBytePlusAssets,
} from '@/models/server/reconcile-byteplus-assets';
import { ensureLocalModelPricingSeeded } from '@/billing/server/seed-model-pricing';
import { ensureSystemTemplatesSeeded } from '@/platform/server/db/seed-system-templates';

import { getLogger, toErrorPayload } from '@/platform/logger';
import { drizzle } from 'drizzle-orm/d1';

const logger = getLogger(['openstory', 'server']);

// System templates self-seed on first request: the first request per isolate
// waits on one D1 SELECT (and, when the stored seed hash is stale — fresh
// deployment or a deploy that changed templates — on the full idempotent
// sync). Memoized per isolate after that. Errors never propagate into the
// response: a failure logs, arms a cooldown, and a later request retries —
// the cooldown keeps a permanently broken state (e.g. missing table) from
// re-running the lock dance and partial sync at request rate.
const SEED_RETRY_COOLDOWN_MS = 60_000;
let seedPromise: Promise<void> | null = null;
let seedRetryAt = 0;
function ensureSeededOnce(db: D1Database, e2eTest?: string): Promise<void> {
  if (seedPromise === null && Date.now() < seedRetryAt) {
    return Promise.resolve();
  }
  seedPromise ??= (async () => {
    const drizzleDb = drizzle(db);
    await ensureSystemTemplatesSeeded(drizzleDb, (message) =>
      logger.info(`[seed] ${message}`)
    );
    // Production pricing stays cron-only. Playwright never fires
    // `scheduled()`, and workflow isolates never hit this fetch path, so
    // e2e also seeds from `scripts/seed.ts --test` in start-webserver. This
    // insert-if-missing pass is the safety net when that CLI seed and the
    // worker D1 diverge.
    if (e2eTest === 'true') {
      await ensureLocalModelPricingSeeded(drizzleDb, (message) =>
        logger.info(`[seed] ${message}`)
      );
    }
  })().catch((error) => {
    seedPromise = null;
    seedRetryAt = Date.now() + SEED_RETRY_COOLDOWN_MS;
    // toErrorPayload preserves .cause — the raw D1 reason that a bare
    // { err } would drop (see logger.ts / #864). This log line is the
    // seeding subsystem's only failure signal.
    logger.error('System template self-seed failed', {
      err: toErrorPayload(error),
    });
  });
  return seedPromise;
}

// Re-export Cloudflare Workflow entrypoint classes so the Worker bundle
// includes them. Each must have a matching entry in `wrangler.jsonc` under
// `workflows[]`.
export { ImageWorkflow } from '@/stills/server/workflows/image-workflow';
export { ElementVisionWorkflow } from '@/cast/server/workflows/element-vision-workflow';
export { ElementSheetWorkflow } from '@/cast/server/workflows/element-sheet-workflow';
export { MusicWorkflow } from '@/audio/server/workflows/music-workflow';
export { MotionWorkflow } from '@/motion/server/workflows/motion-workflow';
export { MotionBatchWorkflow } from '@/motion/server/workflows/motion-batch-workflow';
export { CharacterSheetWorkflow } from '@/cast/server/workflows/character-sheet-workflow';
export { CharacterVoiceWorkflow } from '@/cast/server/workflows/character-voice-workflow';
export { DialogueAudioWorkflow } from '@/motion/server/workflows/dialogue-audio-workflow';
export { LocationSheetWorkflow } from '@/cast/server/workflows/location-sheet-workflow';
export { LibraryTalentSheetWorkflow } from '@/cast/server/workflows/library-talent-sheet-workflow';
export { LibraryLocationSheetWorkflow } from '@/cast/server/workflows/library-location-sheet-workflow';
export { ShotVariantWorkflow } from '@/stills/server/workflows/shot-variant-workflow';
export { UpscaleShotVariantWorkflow } from '@/stills/server/workflows/upscale-shot-variant-workflow';
export { FramePromptWorkflow } from '@/stills/server/workflows/frame-prompt-workflow';
export { MotionPromptWorkflow } from '@/motion/server/workflows/motion-prompt-workflow';
export { MusicPromptWorkflow } from '@/audio/server/workflows/music-prompt-workflow';
export { RecastCharacterWorkflow } from '@/cast/server/workflows/recast-character-workflow';
export { LocationMatchingWorkflow } from '@/cast/server/workflows/location-matching-workflow';
export { ShotImagesWorkflow } from '@/stills/server/workflows/shot-images-workflow';
export { TalentMatchingWorkflow } from '@/cast/server/workflows/talent-matching-workflow';
export { CharacterBibleWorkflow } from '@/cast/server/workflows/character-bible-workflow';
export { LocationBibleWorkflow } from '@/cast/server/workflows/location-bible-workflow';
export { FramePromptBatchWorkflow } from '@/stills/server/workflows/frame-prompt-batch-workflow';
export { MotionPromptBatchWorkflow } from '@/motion/server/workflows/motion-prompt-batch-workflow';
export { MotionMusicPromptsWorkflow } from '@/motion/server/workflows/motion-music-prompts-workflow';
export { RegenerateShotsWorkflow } from '@/shots/server/workflows/regenerate-shots-workflow';
export { UpdateStaleShotsWorkflow } from '@/shots/server/workflows/update-stale-shots-workflow';
export { RecastLocationWorkflow } from '@/cast/server/workflows/recast-location-workflow';
export { ReplaceElementWorkflow } from '@/cast/server/workflows/replace-element-workflow';
export { SceneSplitWorkflow } from '@/sequences/server/workflows/scene-split-workflow';
export { StoryboardWorkflow } from '@/sequences/server/workflows/storyboard-workflow';
export { AnalyzeScriptWorkflow } from '@/sequences/server/workflows/analyze-script-workflow';
export { SequenceExportWorkflow } from '@/sequences/server/workflows/sequence-export-workflow';
export { AssetGenerationWorkflow } from '@/studio/server/workflows/asset-generation-workflow';
export { StudioGenerationWorkflow } from '@/studio/server/workflows/studio-generation-workflow';

// Realtime broker Durable Object. Re-exported so the binding's `class_name`
// in wrangler.jsonc resolves in the Worker bundle (#802).
export { RealtimeChannel } from '@/platform/server/realtime/realtime-channel.do';
export { BytePlusGovernor } from '@/models/server/byteplus-governor.do';

// Server-side video-export container DO (#968). Production-only binding
// (`VIDEO_EXPORT_CONTAINER`); re-exported so its `class_name` resolves in the
// bundle when CLOUDFLARE_ENV=production bakes the [env.production] block.
export { VideoExportContainer } from '@/sequences/server/video-export-container';

// Bindings shape from wrangler.jsonc. Only declared so the scheduled() handler
// has a real type for its env parameter (vs. the framework default of unknown).
interface WorkerEnv {
  DB: D1Database;
  R2_PUBLIC_ASSETS_BUCKET: R2Bucket;
  R2_STORAGE_BUCKET: R2Bucket;
  REALTIME: DurableObjectNamespace;
  E2E_TEST?: 'true';
}

const exportedHandler: ExportedHandler<WorkerEnv> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Media serving (/r2/<key>) never needs templates — don't put the
    // seed check's D1 round trip in front of it on cold starts.
    if (!pathname.startsWith('/r2/')) {
      await ensureSeededOnce(env.DB, env.E2E_TEST);
    }

    // Markdown content negotiation for agents (#819): serve a real markdown
    // rendition where one exists; otherwise fall back to HTML rather than
    // letting the router 500 on a non-HTML Accept header.
    const wantsMarkdown = acceptsMarkdown(request);
    if (wantsMarkdown) {
      const markdown = getMarkdownForPath(pathname);
      if (markdown !== null) return markdownResponse(markdown, request.method);
    }

    const response = await handler.fetch(
      wantsMarkdown ? withHtmlAccept(request) : request
    );
    // RFC 8288 Link headers on document responses for agent discovery.
    return withDiscoveryLinkHeader(response, pathname);
  },
  scheduled(controller, _env, ctx) {
    // Daily fal pricing refresh into the model_pricing table (#1069).
    if (controller.cron === FAL_PRICING_CRON) {
      ctx.waitUntil(
        refreshFalPricing().catch((error) => {
          logger.error('refreshFalPricing failed:', { err: error });
        })
      );
      return;
    }
    // Hourly audit of charges against fal's per-request bill (#1069).
    if (controller.cron === FAL_BILLING_RECONCILE_CRON) {
      ctx.waitUntil(
        reconcileFalBilling().catch((error) => {
          logger.error('reconcileFalBilling failed:', { err: error });
        })
      );
      return;
    }
    // Hourly diff of the BytePlus asset group against the ledger (#1519).
    if (controller.cron === BYTEPLUS_ASSETS_RECONCILE_CRON) {
      ctx.waitUntil(
        reconcileBytePlusAssets().catch((error) => {
          logger.error('reconcileBytePlusAssets failed:', { err: error });
        })
      );
      return;
    }
    // Best-effort sweep for stuck generating-status rows across every table.
    // See src/platform/server/cron/reconcile-all.ts; cron schedule is in wrangler.jsonc.
    ctx.waitUntil(
      reconcileAllStuckJobs().catch((error) => {
        logger.error('reconcileAllStuckJobs failed:', { err: error });
      })
    );
  },
};

export default exportedHandler;
