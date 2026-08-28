/**
 * Asset generation workflow (#458 — direct model access).
 *
 * Runs an ARBITRARY fal endpoint (validated + credit-gated upstream in
 * `createGeneratedAssetFn`) and lands the outputs as a flat team asset:
 *
 *   1. set-running — flips the reserved `generated_assets` row to 'running'.
 *   2. submit-asset-job — submits to the fal queue (raw `@fal-ai/client`
 *      queue API: arbitrary endpoints have no typed @tanstack/ai-fal adapter).
 *   3. asset-poll-batch-N — batched polling like the motion workflow: a tight
 *      ~30s loop inside each step, checkpoint between batches.
 *   4. fetch-result — pulls the queue result and scans it for output files.
 *   5. upload-outputs — uploads each output to R2; stored URLs are
 *      origin-relative `/r2/<key>` (#894).
 *   6. persist-result — flips the row to 'completed' with the outputs.
 *
 * BYOK follows the house pattern (`scopedDb.credentials.resolveKey('fal')`,
 * platform key fallback), applied to the `fal` singleton via `fal.config` —
 * the same singleton the base class routes through the e2e proxy. No credit
 * deduction happens here YET: the raw queue API doesn't surface
 * `unitsBilled`, so we charge nothing rather than guess (`costMicros` stays
 * null). `model_pricing` now covers every catalog endpoint (#1069), so real
 * charging is unblocked once unitsBilled is plumbed through — a follow-up PR;
 * the create fn's `requireCredits` gate is the only billing control today.
 */

import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type {
  GeneratedAssetActivity,
  GeneratedAssetOutput,
  JsonValue,
} from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import {
  extractPromptForProvenance,
  recordProvenance,
} from '@/lib/compliance/provenance';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { getMimeTypeFromExtension } from '@/lib/utils/file';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { AssetGenerationWorkflowInput } from '@/lib/workflow/types';
import { fal } from '@fal-ai/client';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'asset']);

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/** 60 batches × 30s = 30 minutes — matches the motion workflow's budget,
 *  which absorbs provider-side queueing for slow video models. */
const MAX_BATCHES = 60;

/** R2 bucket per activity — assets reuse the existing media buckets. */
const ACTIVITY_BUCKETS: Record<GeneratedAssetActivity, StorageBucket> = {
  image: STORAGE_BUCKETS.THUMBNAILS,
  video: STORAGE_BUCKETS.VIDEOS,
  audio: STORAGE_BUCKETS.AUDIO,
};

/** One provider-hosted output file found in a fal queue result. */
export type AssetOutputRef = {
  url: string;
  /** fal file objects carry `content_type`; null when only a bare URL. */
  contentType: string | null;
};

/** A fal file object (`{ url, content_type, … }`) or a bare URL string. */
function toOutputRef(value: JsonValue): AssetOutputRef | null {
  if (typeof value === 'string') {
    return value.startsWith('http') ? { url: value, contentType: null } : null;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const url = value.url;
    if (typeof url !== 'string') return null;
    const contentType = value.content_type;
    return {
      url,
      contentType: typeof contentType === 'string' ? contentType : null,
    };
  }
  return null;
}

/** Result fields that carry media files across fal endpoints. */
const OUTPUT_FIELDS = [
  'images',
  'image',
  'videos',
  'video',
  'audios',
  'audio',
  'audio_file',
  'outputs',
  'output',
] as const;

/**
 * Scan a fal queue result for output media files. fal output schemas vary per
 * endpoint but converge on a handful of field names holding either a file
 * object (`{ url, content_type }`), a bare URL string, or an array of either
 * — collect them all, in field order. Deduped by URL: endpoints that populate
 * both a singular and plural field (`video` + `output`) with the same file
 * would otherwise upload it twice.
 */
export function extractAssetOutputs(data: JsonValue): AssetOutputRef[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const refs: AssetOutputRef[] = [];
  const seen = new Set<string>();
  for (const field of OUTPUT_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const ref = toOutputRef(candidate);
      if (ref && !seen.has(ref.url)) {
        seen.add(ref.url);
        refs.push(ref);
      }
    }
  }
  return refs;
}

/**
 * fal returns 422 for a payload the endpoint itself rejected — deterministic
 * for a given input, so the workflow must not burn CF retries on it.
 */
export function isFalValidationError(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 422;
}

/** Extension map for provider URLs with no file extension (common on fal). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/**
 * R2 key extension for one output: from the URL path when it has one,
 * otherwise from the content type — fal media URLs frequently omit the
 * extension, and defaulting a video to `.jpg` produces misleading download
 * filenames. `bin` when neither source knows.
 */
export function outputExtension(
  url: string,
  contentType: string | null
): string {
  try {
    const match = /\.([a-zA-Z0-9]+)$/.exec(new URL(url).pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // Not an absolute URL — fall through to the content type.
  }
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return (mime && EXTENSION_BY_MIME[mime]) || 'bin';
}

/** The row writes this workflow needs — a narrow slice of {@link ScopedDb}
 * so unit tests can inject a small spy. */
export type AssetPersistScopedDb = {
  generatedAssets: {
    markRunning: (id: string) => Promise<void>;
    markCompleted: (
      id: string,
      fields: { outputs: GeneratedAssetOutput[]; costMicros?: number | null }
    ) => Promise<void>;
    markFailed: (id: string, error: string) => Promise<void>;
  };
};

/**
 * Resolve the fal key (BYOK via team key, platform fallback) and apply it to
 * the `fal` singleton — the same singleton `configureFalProxyFromEnv` routes
 * through the e2e proxy, and the same `fal.config({ credentials })` call the
 * @tanstack/ai-fal adapters make. Called inside every step that talks to fal,
 * since a replayed step may run in a fresh isolate.
 */
async function configureFalForTeam(scopedDb: WorkflowScopedDb): Promise<void> {
  const keyInfo = await scopedDb.credentials.resolveKey('fal');
  // Bound each queue HTTP call so a hung fal connection fails the step and
  // can retry rather than stalling asset generation forever (#826). Total
  // poll wall-clock is still controlled by the MAX_BATCHES loop above.
  fal.config({
    credentials: keyInfo.key,
    fetch: createDeadlineFetch(
      FAL_REQUEST_TIMEOUT_MS,
      'Asset generation request'
    ),
  });
}

export class AssetGenerationWorkflow extends OpenStoryWorkflowEntrypoint<AssetGenerationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, endpointId, activity, input, teamId } = event.payload;

    await step.do('set-running', async () => {
      await scopedDb.generatedAssets.markRunning(assetId);
    });

    // Submit to the fal queue. A 422 is a payload the endpoint rejected —
    // retrying the same input can't succeed, so fail immediately; anything
    // else is transient and leans on CF's per-step retries.
    const { requestId } = await step.do('submit-asset-job', async () => {
      await configureFalForTeam(scopedDb);
      logger.info(
        `[AssetGenerationWorkflow] Submitting ${endpointId} (${activity}) for asset ${assetId}`
      );
      try {
        const { request_id } = await fal.queue.submit(endpointId, { input });
        return { requestId: request_id };
      } catch (error) {
        if (isFalValidationError(error)) {
          throw new NonRetryableError(
            `Model rejected the input (422): ${extractFalErrorMessage(error)}`
          );
        }
        throw error;
      }
    });

    // Batched polling — tight loop inside each step.do, checkpoint between
    // batches (same shape as the motion workflow). The fal queue reports
    // IN_QUEUE / IN_PROGRESS / COMPLETED; failures surface on fetch-result.
    let completed = false;
    for (let batch = 0; batch < MAX_BATCHES && !completed; batch++) {
      if (batch > 0) {
        await step.sleep(`asset-poll-wait-${batch}`, 1);
      }
      completed = await step.do(`asset-poll-batch-${batch}`, async () => {
        await configureFalForTeam(scopedDb);
        const deadline = Date.now() + POLL_BATCH_DURATION_MS;
        while (Date.now() < deadline) {
          const status = await fal.queue.status(endpointId, {
            requestId,
            logs: false,
          });
          if (status.status === 'COMPLETED') return true;
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        return false;
      });
    }
    if (!completed) {
      throw new Error(
        `Asset generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    // Fetch the result. A failed fal job rejects here with the real error —
    // deterministic, so don't burn CF retries on it.
    const outputRefs = await step.do('fetch-result', async () => {
      await configureFalForTeam(scopedDb);
      let data: JsonValue;
      try {
        const result = await fal.queue.result(endpointId, { requestId });
        data = result.data;
      } catch (error) {
        throw new NonRetryableError(
          `Model run failed: ${extractFalErrorMessage(error)}`
        );
      }
      const refs = extractAssetOutputs(data);
      if (refs.length === 0) {
        // Include the result's shape so a miss in OUTPUT_FIELDS (or a
        // base64-only endpoint) is diagnosable from the row's error message.
        const keys =
          data !== null && typeof data === 'object' && !Array.isArray(data)
            ? Object.keys(data).join(', ')
            : typeof data;
        throw new NonRetryableError(
          `Model returned no output files for ${endpointId} (result keys: ${keys || 'none'})`
        );
      }
      return refs;
    });

    const uploadResult = await step.do('upload-outputs', async () => {
      const uploaded: GeneratedAssetOutput[] = [];
      // Collected alongside the outputs (which store only public URLs) because
      // provenance joins on the R2 key — see recordProvenance below.
      const storageKeys: string[] = [];
      for (const [index, ref] of outputRefs.entries()) {
        const response = await fetch(ref.url);
        if (!response.ok) {
          throw new Error(
            `Failed to download output ${index} from provider: ${response.status}`
          );
        }
        const knownContentType =
          ref.contentType ?? response.headers.get('content-type');
        const extension = outputExtension(ref.url, knownContentType);
        const contentType =
          knownContentType ?? getMimeTypeFromExtension(extension);
        const path = `teams/${teamId}/assets/${assetId}/output-${index}.${extension}`;
        const result = await uploadResponse(
          response,
          ACTIVITY_BUCKETS[activity],
          path,
          { contentType }
        );
        uploaded.push({ url: result.publicUrl, contentType });
        storageKeys.push(result.path);
      }
      return { outputs: uploaded, storageKeys };
    });

    const { outputs, storageKeys } = uploadResult;

    await step.do('persist-result', async () => {
      await persistAssetCompletion({
        scopedDb,
        assetId,
        outputs,
      });
    });

    // Provenance (#1180) — one row per output file, since a single run can emit
    // several and each is separately shareable. Direct model access reaches
    // arbitrary endpoints, so this is the path where an unrecognized model can
    // produce video: exactly the traffic that most needs to be traceable.
    await step.do('record-provenance', async () => {
      for (const [index, storageKey] of storageKeys.entries()) {
        await recordProvenance(scopedDb.provenance, {
          teamId,
          userId: event.payload.userId,
          assetKind: 'generated_asset',
          // Suffixed so multiple outputs of one run don't collide on assetId
          // while still resolving back to the `generated_assets` row.
          assetId: storageKeys.length > 1 ? `${assetId}#${index}` : assetId,
          storageKey,
          provider: 'fal',
          model: endpointId,
          providerRequestId: requestId,
          workflowRunId: event.instanceId,
          prompt: extractPromptForProvenance(input),
        });
      }
    });

    logger.info(
      `[AssetGenerationWorkflow] Completed asset ${assetId} (${outputs.length} output${outputs.length === 1 ? '' : 's'})`
    );
    return { assetId, outputs };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    await persistAssetFailure({
      scopedDb,
      assetId: event.payload.assetId,
      error,
    });
    logger.error(
      `[AssetGenerationWorkflow] Asset ${event.payload.assetId} failed: ${error}`
    );
  }
}

/**
 * Flip the row to `completed` with its uploaded outputs (`error` cleared).
 * `costMicros` stays null until real charging ships (see the module header).
 */
export async function persistAssetCompletion(params: {
  scopedDb: AssetPersistScopedDb;
  assetId: string;
  outputs: GeneratedAssetOutput[];
}): Promise<void> {
  await params.scopedDb.generatedAssets.markCompleted(params.assetId, {
    outputs: params.outputs,
    costMicros: null,
  });
}

/** Flip the row to `failed` with the sanitized error message. */
export async function persistAssetFailure(params: {
  scopedDb: AssetPersistScopedDb;
  assetId: string;
  error: string;
}): Promise<void> {
  await params.scopedDb.generatedAssets.markFailed(
    params.assetId,
    params.error
  );
}
