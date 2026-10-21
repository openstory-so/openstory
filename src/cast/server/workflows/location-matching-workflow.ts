/**
 * The `locationMatchingWorkflow` durable workflow.
 *
 * The LLM call goes through `durableLLMCallCf` (the CF port of
 * `durableLLMCall`); see `src/models/server/llm-call-helper.ts`.
 *
 * This workflow does not invoke any child workflows — it's a leaf
 * orchestrator that runs a single LLM call and assembles matches.
 */

import { buildLocationMatchingPromptVariables } from '@/cast/server/location-matching-prompt';
import { locationMatchResponseSchema } from '@/sequences/response-schemas';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getGenerationChannel } from '@/platform/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import type {
  LibraryLocationMatch,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'location-matching']);

type LocationMatchEntry = {
  libraryLocationId: string;
  locationId: string;
  confidence: number;
};

export class LocationMatchingWorkflow extends OpenStoryWorkflowEntrypoint<LocationMatchingWorkflowInput> {
  protected override readonly failureLabel = 'Location matching';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationMatchingWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LocationMatchingWorkflowOutput> {
    const input = event.payload;
    const { suggestedLocationIds, sequenceId, analysisModelId } = input;

    const locationBible = input.locationBible;

    // The team locations the writer picked. A match is a link and draws no
    // sheet (#1695), so a pick whose sheet is still drawing (or failed) is
    // matched like any other: nothing waits for it. A location deleted from
    // the team is left out of the read.
    const referenceRows =
      suggestedLocationIds?.length && input.teamId
        ? await step.do('read-picked-locations', async () =>
            scopedDb.liveRead.locations.getCurrentByIds(suggestedLocationIds)
          )
        : [];

    // Name/description come from the trigger-time snapshot; only the sheet
    // can have moved since the trigger.
    const snapshotById = new Map(
      (input.suggestedLocations ?? []).map((l) => [l.locationId, l])
    );
    const libraryLocationList = referenceRows.map((row) => {
      const snapshot = snapshotById.get(row.id);
      return snapshot
        ? { ...row, name: snapshot.name, description: snapshot.description }
        : row;
    });
    const locationMatchingPromptVariables =
      libraryLocationList.length > 0
        ? buildLocationMatchingPromptVariables(
            locationBible,
            libraryLocationList
          )
        : {};

    const { matches: locationMatches } =
      libraryLocationList.length > 0
        ? await durableLLMCallCf(
            step,
            {
              name: 'location-matching',
              phase: { number: 2, name: 'Matching locations…' },
              promptName: 'phase/location-matching-chat',
              promptVariables: locationMatchingPromptVariables,
              modelId: analysisModelId,
              responseSchema: locationMatchResponseSchema,
            },
            {
              sequenceId,
              userId: input.userId,
              workflowRunId: event.instanceId,
              scopedDb,
              reservationId: input.reservationId,
            }
          )
        : { matches: [] as LocationMatchEntry[] };

    const libraryLocationMatches: LibraryLocationMatch[] = await step.do(
      'build-location-matches',
      async () => {
        const usedLibraryIds = new Set<string>();
        const usedLocationIds = new Set<string>();
        const matches: LibraryLocationMatch[] = [];

        for (const match of locationMatches) {
          if (usedLibraryIds.has(match.libraryLocationId)) continue;
          if (usedLocationIds.has(match.locationId)) continue;
          if (match.confidence < 0.5) continue;

          const libraryLoc = libraryLocationList.find(
            (lib) => lib.id === match.libraryLocationId
          );
          if (!libraryLoc) continue;

          const location = locationBible.find(
            (loc) => loc.locationId === match.locationId
          );
          if (!location) continue;

          usedLibraryIds.add(match.libraryLocationId);
          usedLocationIds.add(match.locationId);
          matches.push({
            locationId: match.locationId,
            libraryLocationId: match.libraryLocationId,
            libraryLocationName: libraryLoc.name,
            referenceImageUrl: libraryLoc.referenceImageUrl,
          });
        }

        if (matches.length > 0 && sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.location:matched',
            {
              matches: matches.map((m) => {
                const loc = locationBible.find(
                  (l) => l.locationId === m.locationId
                );
                return {
                  locationId: m.locationId,
                  locationName: loc?.name ?? m.locationId,
                  libraryLocationId: m.libraryLocationId,
                  libraryLocationName: m.libraryLocationName,
                  referenceImageUrl: m.referenceImageUrl,
                };
              }),
            }
          );
        }

        return matches;
      }
    );

    logger.info(
      `[LocationMatchingWorkflow:cf] Resolved ${libraryLocationMatches.length} library location match(es) for sequence ${sequenceId ?? '(none)'}`
    );

    return {
      matches: libraryLocationMatches,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<LocationMatchingWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    logger.error(
      `[LocationMatchingWorkflow:cf] Location matching failed for sequence ${input.sequenceId ?? '(none)'}: ${error}`
    );
  }
}
