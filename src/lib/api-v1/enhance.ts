/**
 * Orchestrator for `POST /api/v1/scripts/enhance`. Resolves the public,
 * human-friendly input (style by ref, elements by URL) into the shared
 * {@link streamScriptEnhancement} generator, then shots its deltas as
 * Server-Sent Events.
 *
 *   resolve style → build EnhanceScriptInput → stream deltas as SSE
 *
 * Server-only (imports the AI stack via `@/lib/ai/script-enhancement`); kept
 * separate from
 * `enhance-input-schema.ts` so discovery/OpenAPI can import the schema without
 * pulling this in.
 */

import type { EnhanceScriptInput } from '@/functions/ai';
import {
  type EnhanceChunk,
  streamScriptEnhancement,
} from '@/lib/ai/script-enhancement';
import { assessDurationFit } from '@/lib/ai/enhance-duration';
import { toEnhanceInputs } from '@/lib/ai/enhance-inputs';
import {
  DEFAULT_VIDEO_MODEL,
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { handleApiError } from '@/lib/errors';
import { getLogger, toErrorPayload } from '@/lib/observability/logger';
import { createSequenceLink, enhanceScriptLink } from './discovery';
import type { ApiEnhanceScriptInput } from './enhance-input-schema';
import { API_V1_BASE, type HalLinks, getLink } from './hal';
import { resolveStyle } from './resolve';

const logger = getLogger(['openstory', 'api-v1']);

export type EnhanceContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
};

/**
 * Turn the public enhance input into the shared enhancement generator. When a
 * style reference is given, it's resolved read-only (no library writes) so its
 * aesthetic recipe + identity (name/category/tags) and recommended aspect ratio
 * steer the rewrite — fed via the same `toEnhanceInputs` the UI and create flow
 * use, so all three enhance identically. Throws (→ JSON error) on an
 * unresolvable style reference; the returned generator defers billing and the
 * LLM call to its first `.next()`.
 */
export async function buildEnhanceGenerator(
  input: ApiEnhanceScriptInput,
  ctx: EnhanceContext
): Promise<AsyncGenerator<EnhanceChunk>> {
  const style = input.style
    ? await resolveStyle(ctx.scopedDb, input.style)
    : undefined;

  const data: EnhanceScriptInput = {
    script: input.script,
    targetDuration: input.targetSeconds,
    videoModel:
      input.videoModel && isValidImageToVideoModel(input.videoModel)
        ? input.videoModel
        : DEFAULT_VIDEO_MODEL,
    aspectRatio:
      input.aspectRatio ??
      (style
        ? aspectRatioSchema.safeParse(style.defaultAspectRatio).data
        : undefined),
    // Caller-hosted element URLs go straight to the model (no ingest needed —
    // there's no sequence to persist them into); map url → the tempPublicUrl
    // field `toEnhanceInputs` reads.
    ...toEnhanceInputs({
      style,
      elements: input.elements?.map((el) => ({
        token: el.token,
        tempPublicUrl: el.url,
        description: el.description,
      })),
    }),
  };

  return streamScriptEnhancement(data, {
    scopedDb: ctx.scopedDb,
    userId: ctx.user.id,
    teamId: ctx.teamId,
  });
}

/**
 * The HAL affordance catalog for the terminal `done` shot — the SSE analogue
 * of the `_links` every JSON response carries. The natural next action is
 * creating a sequence from the just-enhanced script, so `create-sequence`
 * embeds a ready-to-POST example body (with `enhance: 'off'`, since the script
 * is already enhanced).
 */
function doneLinks(enhancedScript: string): HalLinks {
  return {
    self: enhanceScriptLink(),
    'create-sequence': {
      ...createSequenceLink(),
      title:
        'Create a video sequence from this enhanced script (use enhance: "off" — it is already enhanced)',
      examples: [{ script: enhancedScript, enhance: 'off' }],
    },
    root: getLink(API_V1_BASE, 'API root / instructions'),
  };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable proxy buffering so deltas flush as they're produced.
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Shot an already-started enhancement generator as an SSE stream. `first` is
 * the result of the caller's initial `gen.next()` — pulled before this is called
 * so pre-stream failures (billing, an unresolvable model) surface as a JSON
 * error with the right status, rather than a 200 stream that immediately errors.
 *
 * Wire format (matches the OpenAPI doc): each delta is an unnamed `data:` shot
 * `{ "delta": "…" }`; a terminal `event: done` shot carries the full
 * `{ "enhancedScript": "…", "_links": {…} }` — the `_links` catalog of next
 * actions every other v1 response carries, attached to the one shot that
 * represents the completed resource. A mid-stream failure (headers already
 * sent) becomes an `event: error` shot `{ code, message }`.
 */
export function enhanceSseResponse(
  first: IteratorResult<EnhanceChunk>,
  rest: AsyncGenerator<EnhanceChunk>,
  opts?: { targetSeconds: number; videoModel: ImageToVideoModel }
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const data = (payload: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      const event = (name: string, payload: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
        );

      let full = '';
      // Reasoning chunks carry `delta: ''` and are dropped here: thinking is a
      // dashboard-stream affordance, not part of the documented v1 wire format.
      const push = (chunk: EnhanceChunk) => {
        if (chunk.replace) {
          full = chunk.delta;
          event('replace', { enhancedScript: full });
          return;
        }
        if (!chunk.delta) return;
        full += chunk.delta;
        data({ delta: chunk.delta });
      };

      try {
        if (!first.done) push(first.value);
        for await (const chunk of rest) push(chunk);
        const enhancedScript = full.trim();
        const duration = opts
          ? assessDurationFit(
              enhancedScript,
              opts.targetSeconds,
              opts.videoModel
            )
          : undefined;
        event('done', {
          enhancedScript,
          ...(duration && duration.snappedSeconds != null ? { duration } : {}),
          _links: doneLinks(enhancedScript),
        });
      } catch (err) {
        const handled = handleApiError(err);
        // Headers are already committed, so this can't become a JSON 500 — but
        // it must still be traceable. Mirror runApiV1Handler: log server-class
        // failures (incl. a post-success `deduct` throw, which lands here) with
        // the original stack/cause; the client only ever sees code/message.
        if (handled.statusCode >= 500) {
          logger.error(
            'api/v1 enhance stream failed mid-stream: {code} {message}',
            {
              code: handled.code,
              message: handled.message,
              err: toErrorPayload(err),
            }
          );
        }
        event('error', { code: handled.code, message: handled.message });
      } finally {
        controller.close();
      }
    },
    async cancel() {
      // Client disconnected — let the generator unwind (skips the final
      // billing deduction, matching the dashboard stream's behaviour). A
      // cleanup failure while unwinding would otherwise surface as an unhandled
      // rejection, so log and swallow it.
      try {
        await rest.return(undefined);
      } catch (err) {
        logger.warn('api/v1 enhance stream cancel: generator cleanup failed', {
          err: toErrorPayload(err),
        });
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
