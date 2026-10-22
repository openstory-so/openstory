/**
 * One-shot create orchestrator for `POST /api/v1/sequences`. Turns the public,
 * human-friendly input into a fully-resolved `CreateSequenceInput` and hands it
 * to the shared `createSequences` core:
 *
 *   ingest hosted refs (no DB) → enhance (optional) →
 *   insert team characters/locations without billed sheets →
 *   validate via createSequenceSchema → createSequences →
 *   enqueue location sheets → response. On failure after insert, the inline
 *   characters and team locations are deleted so a hung fetch cannot leave
 *   charged sheets. A character's sheet is drawn with the sequence.
 *
 * Returns the created sequence ids + workflow run ids (generation is async) and
 * the enhanced script when enhancement ran.
 */

import { z } from 'zod';
import { enhanceScriptToString } from '@/sequences/server/script-enhancement';
import { toEnhanceInputs } from '@/models/enhance-inputs';
import { AUTO_STYLE_ID } from '@/look/auto-style';
import { isValidImageToVideoModel } from '@/models/models';
import { isShortScript } from '@/models/should-enhance';
import { DEFAULT_RESOLUTION } from '@/models/resolutions';
import { DEFAULT_ASPECT_RATIO } from '@/models/aspect-ratios';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { createTeamCharacter } from '@/cast/server/cast-edit';
import {
  createTeamLocation,
  triggerTeamLocationSheet,
} from '@/cast/server/locations/team-locations';
import { renderingOfStyle } from '@/cast/rendering';
import { parseStyleConfig } from '@/look/style-config';
import { getLogger } from '@/platform/logger';
import { createSequenceSchema } from '@/sequences/server/sequence.schemas';
import { createSequences } from '@/sequences/server/create-sequences';
import {
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { SEQUENCE_STATUSES } from '@/platform/server/db/schema/sequences';
import { createSequenceLink } from './discovery';
import {
  API_V1_BASE,
  type HalLinks,
  halLinksSchema,
  getLink,
  waitLink,
} from './hal';
import type { ApiCreateSequenceInput } from './input-schema';
import { apiStopAt } from './input-schema';
import { sequenceStateResourceSchema } from './state';
import {
  ingestElements,
  resolveCharacterIds,
  resolveLocationIds,
  resolveStyle,
} from './resolve';
import { ingestImageToBucket } from './safe-fetch';
import { resolveApiVideoDefaults } from './video-defaults';
import {
  attestUploads,
  classifyUpload,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import { AttestationRequiredError } from '@/platform/errors';
import type { PortraitAttestation } from '@/cast/upload-rights';

const logger = getLogger(['openstory', 'api-v1', 'create']);

export type OneShotContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
  /** Recorded on any portrait sign-off the request carries. */
  request: LikenessRequestContext;
};

/** One created sequence in the (non-`?wait`) create response. */
const oneShotSequenceEntrySchema = z
  .object({
    id: z.string(),
    status: z.enum(SEQUENCE_STATUSES),
    workflowRunId: z.string(),
    statusUrl: z.string(),
    /** Affordances for this sequence: read status, or long-poll it. */
    _links: halLinksSchema,
  })
  .describe('A created sequence (non-?wait response entry).')
  .meta({ id: 'SequenceSummary' });

export const oneShotResultSchema = z
  .object({
    sequences: z.array(oneShotSequenceEntrySchema),
    enhancedScript: z
      .string()
      .optional()
      .describe('Present only when script enhancement ran.'),
    /** Affordances available from the create response itself. */
    _links: halLinksSchema,
  })
  .meta({ id: 'CreateSequenceResult' });

/**
 * One created sequence in the `?wait` create response: the redundant top-level
 * status/statusUrl/_links are dropped in favour of the live embedded `state`,
 * plus the long-poll outcome flags.
 */
const oneShotWaitSequenceEntrySchema = z
  .object({
    id: z.string(),
    workflowRunId: z.string(),
    /** First progress snapshot (with its own `_links`); `null` if unavailable. */
    state: sequenceStateResourceSchema.nullable(),
    waitChanged: z.boolean().describe('The sequence advanced during the wait.'),
    waitDone: z.boolean().describe('The sequence reached a terminal state.'),
  })
  .describe(
    'A created sequence with its first progress snapshot embedded (?wait response entry).'
  )
  .meta({ id: 'WaitedSequence' });

/** The `?wait` variant of {@link OneShotResult} (the wire shape the route returns). */
export const oneShotWaitResultSchema = z
  .object({
    sequences: z.array(oneShotWaitSequenceEntrySchema),
    enhancedScript: z.string().optional(),
    _links: halLinksSchema,
  })
  .meta({ id: 'CreateSequenceWaitResult' });

export type OneShotResult = z.infer<typeof oneShotResultSchema>;
export type OneShotWaitResult = z.infer<typeof oneShotWaitResultSchema>;

type LocationCreate = Exclude<
  NonNullable<ApiCreateSequenceInput['locations']>[number],
  string
>;

function inlineCreates<T>(items: readonly (string | T)[] | undefined): T[] {
  if (!items) return [];
  return items.filter((item): item is T => typeof item !== 'string');
}

/** Ingest hosted reference image URLs into the team's `uploads/` folder. */
async function ingestReferenceImages(
  urls: string[] | undefined,
  bucket: StorageBucket,
  teamId: string,
  labelFor: (index: number) => string
): Promise<string[]> {
  if (!urls || urls.length === 0) return [];
  const ingested = await Promise.all(
    urls.map((url, index) =>
      ingestImageToBucket(url, bucket, teamId, 'uploads', {
        label: labelFor(index),
      })
    )
  );
  return ingested.map((i) => i.publicUrl);
}

/**
 * The likeness gate for API-ingested images (#1581): every one is classified,
 * and a real person needs the item's `portraitAttestation`, which is then
 * recorded for each of that item's images. Runs before any library row.
 */
async function requireIngestedImageRights(
  ctx: OneShotContext,
  items: Array<{
    label: string;
    urls: string[];
    attestation: Omit<PortraitAttestation, 'url'> | undefined;
  }>
): Promise<void> {
  for (const item of items) {
    for (const url of item.urls) {
      const rights = await classifyUpload({
        scopedDb: ctx.scopedDb,
        userId: ctx.user.id,
        url,
        request: ctx.request,
      });
      if (rights.status !== 'needs_portrait') continue;
      if (!item.attestation) {
        throw new AttestationRequiredError(
          `${item.label} shows a real person: portraitAttestation is required`
        );
      }
      await attestUploads(
        ctx.scopedDb,
        [{ url, ...item.attestation }],
        ctx.request
      );
    }
  }
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
  characterIds: string[],
  locationIds: string[]
): Promise<void> {
  const results = await Promise.allSettled([
    // Nothing uses a character or location this request made, so the team
    // delete holds.
    ...characterIds.map((id) => ctx.scopedDb.characters.softDeleteForTeam(id)),
    ...locationIds.map((id) => ctx.scopedDb.locations.softDeleteForTeam(id)),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        'Failed to roll back an inline character or location after create failure',
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

  const [style, elementUploads, ingestedLocations, videoDefaults] =
    await Promise.all([
      // No style (or "auto") is Match script, the app's default (#1213).
      input.style && input.style !== AUTO_STYLE_ID
        ? resolveStyle(ctx.scopedDb, input.style)
        : null,
      ingestElements(ctx.teamId, input.elements),
      ingestInlineLocationImages(input.locations, ctx.teamId),
      resolveApiVideoDefaults(ctx.scopedDb),
    ]);
  await requireIngestedImageRights(ctx, [
    ...inlineCreates<LocationCreate>(input.locations).map((item) => ({
      label: `Location "${item.name}"`,
      urls: ingestedLocations.get(item) ?? [],
      attestation: item.portraitAttestation,
    })),
    ...elementUploads.map((upload, index) => ({
      label: `Element "${upload.token ?? upload.filename}"`,
      urls: [upload.tempPublicUrl],
      attestation: input.elements?.[index]?.portraitAttestation,
    })),
  ]);

  let script = input.script;
  let enhancedScript: string | undefined;
  if (willEnhance) {
    const result = await enhanceScriptToString(
      {
        script: input.script,
        targetDuration: input.targetSeconds,
        videoModel:
          input.videoModels?.find(isValidImageToVideoModel) ??
          videoDefaults.videoModel,
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
  const createdCharacterIds: string[] = [];
  const createdLocationIds: string[] = [];

  try {
    const [castCharacterIds, suggestedLocationIds] = await Promise.all([
      resolveCharacterIds(
        {
          characters: ctx.scopedDb.characters,
          createCharacter: async (item) => {
            // The sequence draws the character's sheet.
            const character = await createTeamCharacter(
              ctx.scopedDb,
              { userId: ctx.user.id },
              {
                name: item.name,
                physicalDescription: item.description,
                isPerson: item.isHuman,
                rendering: renderingOfStyle(
                  style ? parseStyleConfig(style.config) : null
                ),
              }
            );
            createdCharacterIds.push(character.id);
            return character;
          },
        },
        input.characters
      ),
      resolveLocationIds(
        {
          locations: ctx.scopedDb.locations,
          createLocation: async (item) => {
            // A team location (#1695). Rendered as the sequence's style
            // says, unless the caller said.
            const location = await createTeamLocation(
              ctx.scopedDb,
              {
                name: item.name,
                description: item.description ?? null,
                rendering:
                  item.rendering ??
                  renderingOfStyle(style && parseStyleConfig(style.config)),
                photoUrls: ingestedLocations.get(item) ?? [],
              },
              { userId: ctx.user.id, teamId: ctx.teamId, triggerSheet: false }
            );
            createdLocationIds.push(location.id);
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
      styleId: style?.id ?? AUTO_STYLE_ID,
      // Mirror the new-sequence page: fall back to the style's recommended aspect
      // ratio when the caller doesn't pin one.
      aspectRatio:
        input.aspectRatio ?? style?.defaultAspectRatio ?? DEFAULT_ASPECT_RATIO,
      resolution: input.resolution ?? DEFAULT_RESOLUTION,
      analysisModels: input.analysisModels,
      imageModels: input.imageModels,
      videoModels: input.videoModels ?? [videoDefaults.videoModel],
      // Always a stop, never the legacy flags: the app's default when the
      // caller names none (#2084).
      stopAt: apiStopAt(input),
      // Voices are not a caller choice (#2067). Omitted here, createSequences
      // turns them on wherever voice design is configured.
      generateStartFrames: input.startFrames,
      // Like the composer: Draft first only where this team reaches BytePlus.
      // A draft that lands on fal is refused, not rendered.
      draftMotion: input.draftMotion && videoDefaults.byteplus,
      audioModels: input.audioModels,
      // Only Enhance sets the target (#1593); a verbatim script is auto.
      targetDurationSeconds: enhancedScript ? input.targetSeconds : undefined,
      suggestedLocationIds: suggestedLocationIds.length
        ? suggestedLocationIds
        : undefined,
      castCharacterIds: castCharacterIds.length ? castCharacterIds : undefined,
      elementUploads: elementUploads.length ? elementUploads : undefined,
    });

    // 4. Run the shared create core (credits → fan-out → trigger storyboard).
    const { entries } = await createSequences(parsed, {
      ...ctx,
      notify: false,
    });

    // Sequence rows exist — now it's safe to bill sheet generation. Failures
    // here must not fail the create: the client already has sequence ids, and
    // the generation plan owes a missing sheet, so the run draws it.
    await Promise.allSettled(
      createdLocationIds.map((locationId) =>
        triggerTeamLocationSheet(ctx.scopedDb, {
          userId: ctx.user.id,
          teamId: ctx.teamId,
          locationId,
        }).catch((error: unknown) => {
          logger.error('Failed to start the location sheet run', {
            err: error,
            locationId,
          });
        })
      )
    );

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
    await rollbackInlineCreates(ctx, createdCharacterIds, createdLocationIds);
    throw error;
  }
}
