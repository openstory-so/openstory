/**
 * One-shot create orchestrator for `POST /api/v1/sequences`. Turns the public,
 * human-friendly input into a fully-resolved `CreateSequenceInput` and hands it
 * to the shared `createSequences` core:
 *
 *   ingest hosted refs (no DB) → enhance (optional) →
 *   insert talents/locations without billed sheets →
 *   validate via createSequenceSchema → createSequences →
 *   enqueue sheets → response. On failure after insert, inline library
 *   rows are deleted so a hung fetch cannot leave charged sheets.
 *
 * Returns the created sequence ids + workflow run ids (generation is async) and
 * the enhanced script when enhancement ran.
 */

import { enhanceScriptToString } from '@/lib/ai/script-enhancement';
import { toEnhanceInputs } from '@/lib/ai/enhance-inputs';
import { isShortScript } from '@/lib/ai/should-enhance';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  createLibraryLocation,
  enqueueLibraryLocationSheet,
} from '@/lib/locations/create-library-location';
import { getLogger } from '@/lib/observability/logger';
import { createSequenceSchema } from '@/lib/schemas/sequence.schemas';
import { createSequences } from '@/lib/sequences/create-sequences';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { createLibraryTalent } from '@/lib/talent/create-library-talent';
import {
  enqueueLibraryTalentSheet,
  type EnqueueLibraryTalentSheetParams,
} from '@/lib/talent/enqueue-library-talent-sheet';
import type { LibraryLocationSheetWorkflowInput } from '@/lib/workflow/types';
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

const logger = getLogger(['openstory', 'api-v1', 'create']);

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

type CharacterCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['characters']>[number],
  string
>;
type LocationCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['locations']>[number],
  string
>;

function inlineCreates<T>(items: readonly (string | T)[] | undefined): T[] {
  if (!items) return [];
  return items.filter((item): item is T => typeof item !== 'string');
}

/** Ingest hosted reference image URLs into a bucket's temp area → temp URLs. */
async function ingestReferenceImages(
  urls: string[] | undefined,
  bucket: StorageBucket,
  teamId: string,
  labelFor: (index: number) => string
): Promise<string[]> {
  if (!urls || urls.length === 0) return [];
  const ingested = await Promise.all(
    urls.map((url, index) =>
      ingestImageToTempBucket(url, bucket, teamId, {
        label: labelFor(index),
      })
    )
  );
  return ingested.map((i) => i.publicUrl);
}

async function ingestInlineCharacterImages(
  items: ApiCreateSequenceInput['characters'],
  teamId: string
): Promise<Map<CharacterCreate, string[]>> {
  const map = new Map<CharacterCreate, string[]>();
  await Promise.all(
    inlineCreates<CharacterCreate>(items).map(async (item) => {
      const urls = await ingestReferenceImages(
        item.referenceImageUrls,
        STORAGE_BUCKETS.TALENT,
        teamId,
        (index) => `Character "${item.name}" reference image #${index + 1}`
      );
      map.set(item, urls);
    })
  );
  return map;
}

async function ingestInlineLocationImages(
  items: ApiCreateSequenceInput['locations'],
  teamId: string
): Promise<Map<LocationCreate, string[]>> {
  const map = new Map<LocationCreate, string[]>();
  await Promise.all(
    inlineCreates<LocationCreate>(items).map(async (item) => {
      const urls = await ingestReferenceImages(
        item.referenceImageUrls,
        STORAGE_BUCKETS.LOCATIONS,
        teamId,
        (index) => `Location "${item.name}" reference image #${index + 1}`
      );
      map.set(item, urls);
    })
  );
  return map;
}

async function rollbackInlineCreates(
  ctx: OneShotContext,
  talentIds: string[],
  locationIds: string[]
): Promise<void> {
  const results = await Promise.allSettled([
    ...talentIds.map((id) => ctx.scopedDb.talent.delete(id)),
    ...locationIds.map((id) => ctx.scopedDb.locations.delete(id)),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        'Failed to roll back inline library row after create failure',
        {
          err: result.reason,
        }
      );
    }
  }
}

export async function runOneShotCreate(
  input: ApiCreateSequenceInput,
  ctx: OneShotContext
): Promise<OneShotResult> {
  // 1. Resolve style and ingest every hosted image (elements + inline
  //    character/location refs) with no DB writes. A black-holing image host
  //    fails the request before any library row or billed sheet exists
  //    (#1372). Style + elements must be ready before enhancement (#855).
  const willEnhance =
    input.enhance === 'always' ||
    (input.enhance === 'auto' && isShortScript(input.script));

  const [style, elementUploads, ingestedCharacters, ingestedLocations] =
    await Promise.all([
      resolveStyle(ctx.scopedDb, input.style),
      ingestElements(ctx.teamId, input.elements),
      ingestInlineCharacterImages(input.characters, ctx.teamId),
      ingestInlineLocationImages(input.locations, ctx.teamId),
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

  // 2. Insert inline cast + locations without triggering billed sheets.
  //    Sheets enqueue only after `createSequences` succeeds so a later
  //    failure cannot charge the team for work that produced no sequence.
  const createdTalentIds: string[] = [];
  const createdLocationIds: string[] = [];
  const deferredTalentSheets: EnqueueLibraryTalentSheetParams[] = [];
  const deferredLocationSheets: Array<{
    locationId: string;
    workflowInput: LibraryLocationSheetWorkflowInput;
  }> = [];

  try {
    const [suggestedTalentIds, suggestedLocationIds] = await Promise.all([
      resolveTalentIds(
        {
          talent: ctx.scopedDb.talent,
          createTalent: async (item) => {
            const { talent, deferredSheet } = await createLibraryTalent(
              {
                name: item.name,
                description: item.description,
                isHuman: item.isHuman,
                referenceImageUrls: ingestedCharacters.get(item) ?? [],
                portraitAttestation: item.portraitAttestation,
                enqueueSheet: false,
              },
              ctx
            );
            createdTalentIds.push(talent.id);
            if (deferredSheet) deferredTalentSheets.push(deferredSheet);
            return talent;
          },
        },
        input.characters
      ),
      resolveLocationIds(
        {
          locations: ctx.scopedDb.locations,
          createLocation: async (item) => {
            const { location, sheetWorkflowInput } =
              await createLibraryLocation(
                {
                  name: item.name,
                  description: item.description,
                  referenceImageUrls: ingestedLocations.get(item) ?? [],
                },
                ctx,
                { enqueueSheet: false }
              );
            createdLocationIds.push(location.id);
            deferredLocationSheets.push({
              locationId: location.id,
              workflowInput: sheetWorkflowInput,
            });
            return location;
          },
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

    // Sequence rows exist — now it's safe to bill sheet generation. Failures
    // here must not fail the create: the client already has sequence ids, and
    // the storyboard wait-for-sheets gate will surface a missing sheet.
    await Promise.allSettled([
      ...deferredTalentSheets.map((sheet) => enqueueLibraryTalentSheet(sheet)),
      ...deferredLocationSheets.map(({ locationId, workflowInput }) =>
        enqueueLibraryLocationSheet(workflowInput, locationId)
      ),
    ]);

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
            poll: waitLink(
              statusUrl,
              'Long-poll this sequence (e.g. ?wait=60s)'
            ),
          } satisfies HalLinks,
        };
      }),
      enhancedScript,
      _links: {
        self: createSequenceLink(),
        root: getLink(API_V1_BASE, 'API root / instructions'),
      },
    };
  } catch (error) {
    await rollbackInlineCreates(ctx, createdTalentIds, createdLocationIds);
    throw error;
  }
}
