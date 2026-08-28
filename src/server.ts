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
} from '@/lib/agent/discovery';
import { reconcileAllStuckJobs } from '@/lib/cron/reconcile-all';
import {
  FAL_PRICING_CRON,
  refreshFalPricing,
} from '@/lib/cron/refresh-fal-pricing';
import {
  FAL_BILLING_RECONCILE_CRON,
  reconcileFalBilling,
} from '@/lib/cron/reconcile-fal-billing';
import { ensureLocalModelPricingSeeded } from '@/lib/db/seed-model-pricing';
import { ensureSystemTemplatesSeeded } from '@/lib/db/seed-system-templates';

import { getLogger, toErrorPayload } from '@/lib/observability/logger';
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
export { ImageWorkflow } from '@/lib/workflows/image-workflow';
export { ElementVisionWorkflow } from '@/lib/workflows/element-vision-workflow';
export { ElementSheetWorkflow } from '@/lib/workflows/element-sheet-workflow';
export { MusicWorkflow } from '@/lib/workflows/music-workflow';
export { MotionWorkflow } from '@/lib/workflows/motion-workflow';
export { MotionBatchWorkflow } from '@/lib/workflows/motion-batch-workflow';
export { CharacterSheetWorkflow } from '@/lib/workflows/character-sheet-workflow';
export { LocationSheetWorkflow } from '@/lib/workflows/location-sheet-workflow';
export { LibraryTalentSheetWorkflow } from '@/lib/workflows/library-talent-sheet-workflow';
export { LibraryLocationSheetWorkflow } from '@/lib/workflows/library-location-sheet-workflow';
export { ShotVariantWorkflow } from '@/lib/workflows/shot-variant-workflow';
export { UpscaleShotVariantWorkflow } from '@/lib/workflows/upscale-shot-variant-workflow';
export { FramePromptWorkflow } from '@/lib/workflows/frame-prompt-workflow';
export { MotionPromptWorkflow } from '@/lib/workflows/motion-prompt-workflow';
export { MusicPromptWorkflow } from '@/lib/workflows/music-prompt-workflow';
export { RecastCharacterWorkflow } from '@/lib/workflows/recast-character-workflow';
export { LocationMatchingWorkflow } from '@/lib/workflows/location-matching-workflow';
export { ShotImagesWorkflow } from '@/lib/workflows/shot-images-workflow';
export { TalentMatchingWorkflow } from '@/lib/workflows/talent-matching-workflow';
export { CharacterBibleWorkflow } from '@/lib/workflows/character-bible-workflow';
export { LocationBibleWorkflow } from '@/lib/workflows/location-bible-workflow';
export { FramePromptBatchWorkflow } from '@/lib/workflows/frame-prompt-batch-workflow';
export { MotionPromptBatchWorkflow } from '@/lib/workflows/motion-prompt-batch-workflow';
export { MotionMusicPromptsWorkflow } from '@/lib/workflows/motion-music-prompts-workflow';
export { RegenerateShotsWorkflow } from '@/lib/workflows/regenerate-shots-workflow';
export { UpdateStaleShotsWorkflow } from '@/lib/workflows/update-stale-shots-workflow';
export { RecastLocationWorkflow } from '@/lib/workflows/recast-location-workflow';
export { ReplaceElementWorkflow } from '@/lib/workflows/replace-element-workflow';
export { SceneSplitWorkflow } from '@/lib/workflows/scene-split-workflow';
export { StoryboardWorkflow } from '@/lib/workflows/storyboard-workflow';
export { AnalyzeScriptWorkflow } from '@/lib/workflows/analyze-script-workflow';
export { SequenceExportWorkflow } from '@/lib/workflows/sequence-export-workflow';
export { AssetGenerationWorkflow } from '@/lib/workflows/asset-generation-workflow';
export { StudioGenerationWorkflow } from '@/lib/workflows/studio-generation-workflow';

// Realtime broker Durable Object. Re-exported so the binding's `class_name`
// in wrangler.jsonc resolves in the Worker bundle (#802).
export { RealtimeChannel } from '@/lib/realtime/realtime-channel.do';

// Server-side video-export container DO (#968). Production-only binding
// (`VIDEO_EXPORT_CONTAINER`); re-exported so its `class_name` resolves in the
// bundle when CLOUDFLARE_ENV=production bakes the [env.production] block.
export { VideoExportContainer } from '@/lib/containers/video-export-container';

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
    // Best-effort sweep for stuck generating-status rows across every table.
    // See src/lib/cron/reconcile-all.ts; cron schedule is in wrangler.jsonc.
    ctx.waitUntil(
      reconcileAllStuckJobs().catch((error) => {
        logger.error('reconcileAllStuckJobs failed:', { err: error });
      })
    );
  },
};

export default exportedHandler;
