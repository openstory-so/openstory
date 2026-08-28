/**
 * One-shot create orchestrator for `POST /api/v1/sequences`. Turns the public,
 * human-friendly input into a fully-resolved `CreateSequenceInput` and hands it
 * to the shared `createSequences` core:
 *
 *   enhance (optional) → resolve style/talent/location/elements →
 *   validate via createSequenceSchema → createSequences → response
 *
 * Returns the created sequence ids + workflow run ids (generation is async) and
 * the enhanced script when enhancement ran.
 */

import { enhanceScriptToString } from '@/lib/ai/script-enhancement';
import { toEnhanceInputs } from '@/lib/ai/enhance-inputs';
import { isShortScript } from '@/lib/ai/should-enhance';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { createLibraryLocation } from '@/lib/locations/create-library-location';
import { createSequenceSchema } from '@/lib/schemas/sequence.schemas';
import { createSequences } from '@/lib/sequences/create-sequences';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { createLibraryTalent } from '@/lib/talent/create-library-talent';
import type { SequenceStatus } from '@/lib/db/schema/sequences';
import { createSequenceLink } from './discovery';
import {
  API_V1_BASE,
  type HalLinks,
  type HalResource,
  getLink,
  waitLink,
} from './hal';
import type { ApiCreateSequenceInput } from './input-schema';
import type { SequenceState } from './state';
import {
  ingestElements,
  resolveLocationIds,
  resolveStyle,
  resolveTalentIds,
} from './resolve';
import { ingestImageToTempBucket } from './safe-fetch';

export type OneShotContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
};

/** One created sequence in the (non-`?wait`) create response. */
type OneShotSequenceEntry = {
  id: string;
  status: SequenceStatus;
  workflowRunId: string;
  statusUrl: string;
  /** Affordances for this sequence: read status, or long-poll it. */
  _links: HalLinks;
};

export type OneShotResult = {
  sequences: OneShotSequenceEntry[];
  enhancedScript?: string;
  /** Affordances available from the create response itself. */
  _links: HalLinks;
};

/**
 * One created sequence in the `?wait` create response: the redundant top-level
 * status/statusUrl/_links are dropped in favour of the live embedded `state`,
 * plus the long-poll outcome flags.
 */
type OneShotWaitSequenceEntry = {
  id: string;
  workflowRunId: string;
  /** First progress snapshot (with its own `_links`); `null` if unavailable. */
  state: HalResource<SequenceState> | null;
  /** The sequence advanced during the wait. */
  waitChanged: boolean;
  /** The sequence reached a terminal state during the wait. */
  waitDone: boolean;
};

/** The `?wait` variant of {@link OneShotResult} (the wire shape the route returns). */
export type OneShotWaitResult = {
  sequences: OneShotWaitSequenceEntry[];
  enhancedScript?: string;
  _links: HalLinks;
};

/** Ingest hosted reference image URLs into a bucket's temp area → temp URLs. */
async function ingestReferenceImages(
  urls: string[] | undefined,
  bucket: StorageBucket,
  teamId: string
): Promise<string[]> {
  if (!urls || urls.length === 0) return [];
  const ingested = await Promise.all(
    urls.map((url) => ingestImageToTempBucket(url, bucket, teamId))
  );
  return ingested.map((i) => i.publicUrl);
}

export async function runOneShotCreate(
  input: ApiCreateSequenceInput,
  ctx: OneShotContext
): Promise<OneShotResult> {
  // 1. Optionally enhance the script. `always` forces it; `auto` enhances only
  //    a short/thin script (same heuristic as the new-sequence nudge); `off`
  //    leaves it verbatim.
  const willEnhance =
    input.enhance === 'always' ||
    (input.enhance === 'auto' && isShortScript(input.script));

  // Resolve the style and ingest any elements up front: the enhancer is
  // style-aware AND weaves uploaded elements into the script, so both must be
  // ready before we enhance — exactly what the UI passes to the same enhancer
  // (issue #855). The element ingest is reused for the sequence in step 3.
  const [style, elementUploads] = await Promise.all([
    resolveStyle(ctx.scopedDb, input.style),
    ingestElements(ctx.teamId, input.elements),
  ]);

  let script = input.script;
  let enhancedScript: string | undefined;
  if (willEnhance) {
    const result = await enhanceScriptToString(
      {
        script: input.script,
        targetDuration: input.targetSeconds,
        aspectRatio: input.aspectRatio,
        // Feed the enhancer the same style + element inputs the UI does.
        ...toEnhanceInputs({ style, elements: elementUploads }),
      },
      { scopedDb: ctx.scopedDb, userId: ctx.user.id, teamId: ctx.teamId }
    );
    if (result.length > 0) {
      enhancedScript = result;
      script = result;
    }
  }

  // 2. Resolve the remaining references in parallel — cast + locations. Both are
  //    unified lists (ref strings + inline create objects); inline-create
  //    delegates to the real library-create cores (which trigger sheet
  //    generation), so the storyboard workflow's sheet/vision-wait gates block
  //    on the new entities before matching.
  const [suggestedTalentIds, suggestedLocationIds] = await Promise.all([
    resolveTalentIds(
      {
        talent: ctx.scopedDb.talent,
        createTalent: async (item) => {
          const { talent } = await createLibraryTalent(
            {
              name: item.name,
              description: item.description,
              isHuman: item.isHuman,
              referenceImageUrls: await ingestReferenceImages(
                item.referenceImageUrls,
                STORAGE_BUCKETS.TALENT,
                ctx.teamId
              ),
              portraitAttestation: item.portraitAttestation,
            },
            ctx
          );
          return talent;
        },
      },
      input.characters
    ),
    resolveLocationIds(
      {
        locations: ctx.scopedDb.locations,
        createLocation: async (item) =>
          createLibraryLocation(
            {
              name: item.name,
              description: item.description,
              referenceImageUrls: await ingestReferenceImages(
                item.referenceImageUrls,
                STORAGE_BUCKETS.LOCATIONS,
                ctx.teamId
              ),
            },
            ctx
          ),
      },
      input.locations
    ),
  ]);

  // 3. Assemble + validate the strict create input. createSequenceSchema applies
  //    model defaults and validates every model key, so an invalid model id
  //    surfaces as a 400 rather than a downstream throw.
  const parsed = createSequenceSchema.parse({
    title: input.title,
    script,
    styleId: style.id,
    // Mirror the new-sequence page: fall back to the style's recommended aspect
    // ratio when the caller doesn't pin one.
    aspectRatio:
      input.aspectRatio ?? style.defaultAspectRatio ?? DEFAULT_ASPECT_RATIO,
    analysisModels: input.analysisModels,
    imageModels: input.imageModels,
    videoModels: input.videoModels,
    autoGenerateMotion: input.motion,
    autoGenerateMusic: input.music,
    audioModels: input.audioModels,
    // Same duration chip as Enhance / dashboard Generate ActionCost (#1140).
    targetDurationSeconds: input.targetSeconds,
    suggestedTalentIds: suggestedTalentIds.length
      ? suggestedTalentIds
      : undefined,
    suggestedLocationIds: suggestedLocationIds.length
      ? suggestedLocationIds
      : undefined,
    elementUploads: elementUploads.length ? elementUploads : undefined,
  });

  // 4. Run the shared create core (credits → fan-out → trigger storyboard).
  const { entries } = await createSequences(parsed, {
    ...ctx,
    notify: false,
  });

  return {
    sequences: entries.map(({ sequence, workflowRunId }) => {
      const statusUrl = `${API_V1_BASE}/sequences/${sequence.id}`;
      return {
        id: sequence.id,
        status: sequence.status,
        workflowRunId,
        statusUrl,
        _links: {
          self: getLink(statusUrl, 'Sequence status'),
          poll: waitLink(statusUrl, 'Long-poll this sequence (e.g. ?wait=60s)'),
        } satisfies HalLinks,
      };
    }),
    enhancedScript,
    _links: {
      self: createSequenceLink(),
      root: getLink(API_V1_BASE, 'API root / instructions'),
    },
  };
}
