/**
 * Render the 1080p final of an Ark draft (#1756).
 *
 * The request's only content is the draft's task id — Ark reuses the model,
 * prompt, assets, seed, audio setting, ratio and duration from the draft, so
 * nothing is re-ingested and no prompt is re-sent. `@tanstack/ai-byteplus`
 * builds `content[]` from prompt parts only and has no `draft_task` part, so
 * this is a direct call to the same task endpoint; polling goes through the
 * adapter as for any other Ark job, since a poll is a GET by id.
 *
 * Seedance 2.5 accepts only 1080p here and the id is valid for seven days
 * from the draft's `created_at` — an expired id fails as an Ark error, the
 * failure the user sees. Never falls back to a fresh render.
 */

import { withBytePlusQuotaRetry } from './quota-retry';
import { arkAdapterConfig, getArkApiKey } from './byteplus-config';
import { DRAFT_FINAL_RESOLUTION } from '@/motion/draft-mode';
import { FAL_REQUEST_TIMEOUT_MS } from './fal-deadline-fetch';

const TASKS_PATH = '/contents/generations/tasks';

export async function submitBytePlusFinalRender(options: {
  /** Ark model id — must match the model that created the draft. */
  modelId: string;
  draftTaskId: string;
  /** Log label for the quota-retry loop, e.g. 'motion final submit'. */
  label: string;
}): Promise<{ jobId: string }> {
  const arkKey = getArkApiKey();
  if (!arkKey) {
    throw new Error('ARK_API_KEY is required to render a draft at quality');
  }
  // Lazy like `loadBytePlusVideo` — a static import lands in the Worker
  // startup graph via src/server.ts.
  const { withBytePlusArkDefaults, bytePlusArkHeaders, bytePlusArkError } =
    await import('@tanstack/ai-byteplus');
  const { apiKey, ...config } = arkAdapterConfig(
    arkKey,
    FAL_REQUEST_TIMEOUT_MS
  );
  const client = withBytePlusArkDefaults({ apiKey, ...config });
  const body = JSON.stringify({
    model: options.modelId,
    content: [{ type: 'draft_task', draft_task: { id: options.draftTaskId } }],
    resolution: DRAFT_FINAL_RESOLUTION,
    watermark: false,
  });
  return withBytePlusQuotaRetry(options.label, async () => {
    const response = await client.fetch(`${client.baseURL}${TASKS_PATH}`, {
      method: 'POST',
      headers: bytePlusArkHeaders(client.apiKey),
      body,
      signal: AbortSignal.timeout(client.timeout),
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw bytePlusArkError(response.status, json, 'final render from draft');
    }
    const id =
      typeof json === 'object' && json !== null && 'id' in json
        ? json.id
        : undefined;
    if (typeof id !== 'string' || !id) {
      throw new Error('byteplus: final render returned no task id');
    }
    return { jobId: id };
  });
}
