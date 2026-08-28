/**
 * Cloudflare Workflows port of `locationMatchingWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/location-matching-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *
 * The LLM call goes through `durableLLMCallCf` (the CF port of
 * `durableLLMCall`); see `src/lib/workflows/llm-call-helper.ts`.
 *
 * This workflow does not invoke any child workflows — it's a leaf
 * orchestrator that runs a single LLM call and assembles matches.
 */

import { buildLocationMatchingPromptVariables } from '@/lib/ai/location-matching-prompt';
import { locationMatchResponseSchema } from '@/lib/ai/response-schemas';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { durableLLMCallCf } from '@/lib/workflows/llm-call-helper';
import { waitForLocationReferences } from '@/lib/workflows/wait-for-sheets';
import type {
  LibraryLocationMatch,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'location-matching']);

type LocationMatchEntry = {
  libraryLocationId: string;
  locationId: string;
  confidence: number;
};

export class LocationMatchingWorkflow extends OpenStoryWorkflowEntrypoint<LocationMatchingWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationMatchingWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LocationMatchingWorkflowOutput> {
    const input = event.payload;
    const { suggestedLocationIds, sequenceId, analysisModelId } = input;

    const locationBible = input.locationBible;

    // Location matching drops any library location without a `referenceImageUrl`
    // (see build-location-matches below). A location the user just added while
    // creating this sequence — especially one created from name/description with
    // no uploaded image — only gets its reference once the fire-and-forget
    // `/library-location-sheet` workflow finishes. Wait (bounded) for those
    // references first so pre-selected locations aren't silently skipped.
    const referenceRows =
      suggestedLocationIds?.length && input.teamId
        ? (
            await waitForLocationReferences(
              step,
              scopedDb.liveRead,
              suggestedLocationIds,
              {
                // Surface the wait in the generation progress dialog (phase 2
                // is the "Casting characters & locations…" step). Only emitted
                // when we actually have to wait, so a ready library never
                // flashes a spurious status.
                onWaitNeeded: async () => {
                  if (!sequenceId) return;
                  await getGenerationChannel(sequenceId).emit(
                    'generation.phase:start',
                    {
                      phase: 2,
                      phaseName: 'Waiting for location references…',
                    }
                  );
                },
              }
            )
          ).rows
        : [];

    // The wait's final poll IS the read. Name/description come from the
    // trigger-time snapshot; only `referenceImageUrl` legitimately arrives
    // late (fire-and-forget `/library-location-sheet`).
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
          if (!libraryLoc?.referenceImageUrl) continue;

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
            description: libraryLoc.description ?? undefined,
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
                  description: m.description ?? undefined,
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
