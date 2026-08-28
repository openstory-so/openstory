/**
 * Client for rendering style samples through the REAL OpenStory pipeline
 * (issue #801) — `POST /api/v1/sequences` + long-poll `GET /api/v1/sequences/:id`.
 *
 * Every sample renders this way: a per-beat text-to-image render carries
 * nothing between shots, so a recurring person changes face/hair/wardrobe
 * every cut. The real pipeline's character-bible + reference-sheet system
 * holds identity across frames, and the samples exercise the production path
 * end-to-end — the sample script drives it headlessly through the public API.
 *
 * Script-only helper for `scripts/generate-style-sample-videos.ts` — not
 * imported by the app, so nothing here ships in the worker bundle.
 */

import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { z } from 'zod';

/** Sequence statuses past which no further generation happens. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'archived']);

/**
 * The slice of the public sequence-state document this client consumes.
 * Deliberately lenient (`z.looseObject` semantics via picking fields) — the
 * API is versioned and additive, so unknown fields must never fail a render.
 */
const sequenceStateSchema = z.object({
  id: z.string(),
  status: z.string(),
  statusError: z.string().nullish(),
  // `shots`, not `frames` (#1067). The public API renamed both the array and
  // its count; validating the old shape threw on every poll, which broke
  // sample rendering end to end.
  shots: z.array(
    z.object({
      id: z.string(),
      orderIndex: z.number(),
      title: z.string().nullish(),
      image: z.object({
        status: z.string(),
        url: z.string().nullish(),
      }),
      video: z.object({
        status: z.string(),
        url: z.string().nullish(),
      }),
    })
  ),
  counts: z.object({
    shots: z.number(),
    imagesReady: z.number(),
    videosReady: z.number(),
    videosFailed: z.number(),
  }),
});

export type SampleSequenceState = z.infer<typeof sequenceStateSchema>;

const createResponseSchema = z.object({
  sequences: z
    .array(z.object({ id: z.string(), workflowRunId: z.string() }))
    .min(1),
  /** Present when the platform enhanced the script (`enhance: 'always'`). */
  enhancedScript: z.string().optional(),
});

export type SamplePipelineConfig = {
  /** App origin, e.g. `http://localhost:3000` or `https://openstory.so`. */
  baseUrl: string;
  /** Public-API key (`osk_…`) whose team has styles + credits. */
  apiKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

export type CreateSampleSequenceArgs = {
  script: string;
  title: string;
  /**
   * `off` for already-reviewed prose (bespoke beats, hand-written overrides) —
   * the pipeline scene-splits it verbatim. `always` for a raw brief — the
   * platform's own script-enhancer expands it server-side, so the sample run
   * needs no local LLM key for people-led canonicals.
   */
  enhance: 'always' | 'off';
  /** Target length in seconds, applied when enhancement runs. */
  targetSeconds?: number;
  /** Resolved server-side by name/slug — templates are seeded as system styles. */
  styleName: string;
  aspectRatio: AspectRatio;
  imageModel: string;
  videoModel: string;
  /**
   * Generate motion (image-to-video) for each frame. Defaults to `true`.
   * Set `false` for an images-only render — shots are produced and reviewable,
   * but no clips, so {@link orderedShotVideos}/concat are skipped by callers.
   */
  motion?: boolean;
};

function headers(config: SamplePipelineConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Max create re-attempts when the per-key rate limit (10 req/s) pushes back. */
const MAX_CREATE_RATE_LIMIT_RETRIES = 10;

/**
 * Backoff for a 429: honour the server's `Retry-After` (seconds; the public
 * API always sends it) plus a little jitter so ~90 parallel jobs don't all
 * retry in the same second; fall back to doubling capped at 30s.
 */
function rateLimitDelayMs(res: Response, attempt: number): number {
  const jitter = Math.random() * 200;
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0) return header * 1000 + jitter;
  return Math.min(30_000, 1000 * 2 ** attempt) + jitter;
}

async function errorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 500);
}

/**
 * Create one sequence for a sample render. See {@link CreateSampleSequenceArgs}
 * for the enhance contract; when the platform enhanced the script, the result
 * carries `enhancedScript` so callers can persist it for review.
 */
export async function createSampleSequence(
  config: SamplePipelineConfig,
  args: CreateSampleSequenceArgs
): Promise<{ id: string; workflowRunId: string; enhancedScript?: string }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const init = {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({
      script: args.script,
      title: args.title,
      enhance: args.enhance,
      ...(args.targetSeconds !== undefined && {
        targetSeconds: args.targetSeconds,
      }),
      style: args.styleName,
      aspectRatio: args.aspectRatio,
      imageModels: [args.imageModel],
      videoModels: [args.videoModel],
      motion: args.motion ?? true,
      // Sequence music is generated too — it's a sequence-level asset on the
      // account (mixed client-side in the app), NOT baked into the frame clips
      // this client downloads, so the local concat stays silent regardless.
      // Skipped alongside motion: an images-only render is for eyeballing
      // stills, so there's no point billing music either.
      music: args.motion ?? true,
    }),
  };
  let res = await fetchImpl(`${config.baseUrl}/api/v1/sequences`, init);
  // A burst of parallel creates can trip the per-key 10 req/s limit — back
  // off per Retry-After and re-send (create is idempotent from our side: a
  // 429 was never admitted, so re-sending cannot double-create).
  for (
    let attempt = 1;
    res.status === 429 && attempt <= MAX_CREATE_RATE_LIMIT_RETRIES;
    attempt++
  ) {
    await sleep(rateLimitDelayMs(res, attempt));
    res = await fetchImpl(`${config.baseUrl}/api/v1/sequences`, init);
  }
  if (!res.ok) {
    throw new Error(
      `Create sequence failed (${res.status}) for "${args.title}": ${await errorBody(res)}`
    );
  }
  const parsed = createResponseSchema.parse(await res.json());
  const [sequence] = parsed.sequences;
  if (!sequence) throw new Error(`Create returned no sequence: ${args.title}`);
  return { ...sequence, enhancedScript: parsed.enhancedScript };
}

type SampleSequenceProgress = {
  status: string;
  shots: number;
  imagesReady: number;
  videosReady: number;
  videosFailed: number;
};

function progressOf(state: SampleSequenceState): SampleSequenceProgress {
  return { status: state.status, ...state.counts };
}

function progressKey(p: SampleSequenceProgress): string {
  return [p.status, p.shots, p.imagesReady, p.videosReady, p.videosFailed].join(
    '|'
  );
}

export type WaitForSampleSequenceArgs = {
  id: string;
  /** Overall deadline; the real pipeline is much slower than bare fal calls. */
  timeoutMs?: number;
  /** Server-side long-poll window per request (capped at 90s by the API). */
  waitSeconds?: number;
  /** Client-side pause between polls that returned unchanged. */
  pollDelayMs?: number;
  /** Fires whenever status or any ready/failed count advances. */
  onProgress?: (progress: SampleSequenceProgress) => void;
};

/**
 * Long-poll a sequence until it reaches a terminal state, then verify the
 * render actually succeeded end-to-end: `completed` alone is NOT enough — a
 * sequence completes even when individual frame videos failed, so
 * `videosFailed`/`videosReady` are checked explicitly (a sample needs every
 * clip).
 */
export async function waitForSampleSequence(
  config: SamplePipelineConfig,
  args: WaitForSampleSequenceArgs
): Promise<SampleSequenceState> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 45 * 60 * 1000;
  const waitSeconds = args.waitSeconds ?? 60;
  const pollDelayMs = args.pollDelayMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  let lastKey = '';
  let rateLimitStreak = 0;
  while (Date.now() < deadline) {
    const res = await fetchImpl(
      `${config.baseUrl}/api/v1/sequences/${args.id}?wait=${waitSeconds}s`,
      { headers: headers(config) }
    );
    // Per-key 10 req/s limit: ~90 parallel pollers all fire their first GET
    // in the same second, so 429s are expected at kickoff — back off per
    // Retry-After and keep polling (the overall deadline still bounds us).
    if (res.status === 429) {
      rateLimitStreak += 1;
      await sleep(rateLimitDelayMs(res, rateLimitStreak));
      continue;
    }
    rateLimitStreak = 0;
    if (!res.ok) {
      throw new Error(
        `Poll failed (${res.status}) for sequence ${args.id}: ${await errorBody(res)}`
      );
    }
    const state = sequenceStateSchema.parse(await res.json());

    const progress = progressOf(state);
    const key = progressKey(progress);
    if (key !== lastKey) {
      lastKey = key;
      args.onProgress?.(progress);
    }

    if (TERMINAL_STATUSES.has(state.status)) {
      assertRenderComplete(state);
      return state;
    }
    if (pollDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
  }
  throw new Error(`Timed out waiting for sequence ${args.id}`);
}

function assertRenderComplete(state: SampleSequenceState): void {
  const { shots, videosReady, videosFailed } = state.counts;
  const everyClipReady =
    shots > 0 && videosReady >= shots && videosFailed === 0;

  if (state.status !== 'completed') {
    // A sequence can end `failed` with every clip actually rendered — e.g. the
    // workflow's parent timed out and a late child's parent-notify failed with
    // `instance.in_finite_state`, marking the status row failed AFTER all the
    // work landed. The clips are what a sample needs, so accept the state
    // rather than forcing a re-bill; the caller can inspect `status` to warn.
    if (everyClipReady) return;
    throw new Error(
      `Sequence ${state.id} ended ${state.status}: ${state.statusError ?? 'no error detail'}`
    );
  }
  if (shots === 0) {
    throw new Error(`Sequence ${state.id} completed with no shots`);
  }
  if (!everyClipReady) {
    throw new Error(
      `Sequence ${state.id} completed with ${videosReady}/${shots} videos ready ` +
        `(${videosFailed} failed) — a sample needs every clip`
    );
  }
}

/** Shots in playback order with their (required) video URLs. */
export function orderedShotVideos(state: SampleSequenceState): {
  shotId: string;
  orderIndex: number;
  videoUrl: string;
  imageUrl: string | null;
}[] {
  return [...state.shots]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((shot) => {
      if (!shot.video.url) {
        throw new Error(
          `Shot ${shot.id} of sequence ${state.id} has no video URL`
        );
      }
      return {
        shotId: shot.id,
        orderIndex: shot.orderIndex,
        videoUrl: shot.video.url,
        imageUrl: shot.image.url ?? null,
      };
    });
}
