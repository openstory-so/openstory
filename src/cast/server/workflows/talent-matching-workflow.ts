/**
 * The `talentMatchingWorkflow` durable workflow.
 *
 * The LLM call goes through `durableLLMCallCf`; see
 * `src/models/server/llm-call-helper.ts`.
 */

import { talentMatchResponseSchema } from '@/sequences/response-schemas';
import { buildMatchingPromptVariables } from '@/cast/server/talent-matching-prompt';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getGenerationChannel } from '@/platform/realtime';
import { GENERATION_STAGE_META } from '@/sequences/pipeline';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import { waitForTalentSheets } from './wait-for-sheets';
import type {
  TalentCharacterMatch,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'talent-matching']);

export class TalentMatchingWorkflow extends OpenStoryWorkflowEntrypoint<TalentMatchingWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<TalentMatchingWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<TalentMatchingWorkflowOutput> {
    const input = event.payload;
    const { suggestedTalentIds, sequenceId, analysisModelId } = input;

    // Use pre-extracted bible from scene splitting (always provided by upstream).
    // A voice-only character has no face to cast (#1585): it is never offered
    // to the matcher, and `build-matches` below drops any match naming it.
    const characterBible = input.characterBible.filter((c) => !c.voiceOnly);

    // Talent matching only runs against pre-selected talent IDs. Characters
    // without a pre-cast talent are auto-extracted later in the pipeline and
    // given AI-generated portraits — that path never waits for sheets.
    //
    // For PRE-CAST talent, though, we DO need the casting reference: the
    // matches below read `defaultSheet?.imageUrl`. Talent the user just added
    // while creating this sequence may still be generating their sheet in the
    // fire-and-forget `/library-talent-sheet` workflow, so wait (bounded) for
    // those sheets before reading them — otherwise the cast character is
    // generated with an empty reference and won't look like the chosen talent.
    const sheetRows =
      suggestedTalentIds?.length && input.teamId
        ? (
            await waitForTalentSheets(
              step,
              scopedDb.liveRead,
              suggestedTalentIds,
              {
                // Surface the wait in the generation progress dialog. Casting runs inside
                // the Script phase; only emitted when
                // we actually have to wait, so a ready library never flashes a
                // spurious status.
                onWaitNeeded: async () => {
                  if (!sequenceId) return;
                  await getGenerationChannel(sequenceId).emit(
                    'generation.phase:start',
                    {
                      phase: GENERATION_STAGE_META.script.phase,
                      phaseName: 'Waiting for talent sheets…',
                    }
                  );
                },
              }
            )
          ).rows
        : [];

    // The wait's final poll IS the read: re-querying here would discard a
    // fresher result and re-open the race it just closed. Name/description/
    // performance come from the trigger-time snapshot — only the sheet image is
    // allowed to arrive late, so an edit mid-run must not change who we cast.
    const snapshotById = new Map(
      (input.suggestedTalent ?? []).map((t) => [t.talentId, t])
    );
    const talentList = sheetRows.map((row) => {
      const snapshot = snapshotById.get(row.id);
      return snapshot
        ? {
            ...row,
            name: snapshot.name,
            description: snapshot.description,
            personality: snapshot.personality,
            movement: snapshot.movement,
            voiceId: snapshot.voiceId,
            voiceDescription: snapshot.voiceDescription,
          }
        : row;
    });
    const matchingPromptVariables =
      talentList.length > 0
        ? buildMatchingPromptVariables(characterBible, talentList)
        : {};

    const { matches: talentMatches } =
      talentList.length > 0
        ? await durableLLMCallCf(
            step,
            {
              name: 'talent-matching',
              phase: { number: 2, name: 'Matching talent…' },
              promptName: 'phase/talent-matching-chat',
              promptVariables: matchingPromptVariables,
              modelId: analysisModelId,
              responseSchema: talentMatchResponseSchema,
            },
            {
              sequenceId,
              userId: input.userId,
              workflowRunId: event.instanceId,
              scopedDb,
              reservationId: input.reservationId,
            }
          )
        : { matches: [] as Array<{ characterId: string; talentId: string }> };

    const talentCharacterMatches: TalentCharacterMatch[] = await step.do(
      'build-matches',
      async () => {
        const usedTalentIds = new Set<string>();
        const matches: TalentCharacterMatch[] = [];

        for (const match of talentMatches) {
          // Ensure each talent is only cast once (but characters can have multiple talents
          // when there are more talents than characters)
          if (usedTalentIds.has(match.talentId)) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Skipping duplicate talent ${match.talentId}`
            );
            continue;
          }

          const talent = talentList.find((t) => t.id === match.talentId);
          if (!talent) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Talent ${match.talentId} not found in list`
            );
            continue;
          }

          const character = characterBible.find(
            (c) => c.characterId === match.characterId
          );
          if (!character) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Character ${match.characterId} not found in bible`
            );
            continue;
          }

          usedTalentIds.add(match.talentId);
          matches.push({
            characterId: match.characterId,
            talentId: match.talentId,
            talentName: talent.name,
            sheetImageUrl: talent.defaultSheet?.imageUrl ?? '',
            sheetMetadata: talent.defaultSheet?.metadata ?? undefined,
            talentDescription: talent.description ?? undefined,
            personality: talent.personality ?? '',
            movement: talent.movement ?? '',
            voiceId: talent.voiceId,
            voiceDescription: talent.voiceDescription,
          });
        }

        if (matches.length > 0) {
          await getGenerationChannel(sequenceId).emit(
            'generation.talent:matched',
            {
              matches: matches.map((m) => {
                const char = characterBible.find(
                  (c) => c.characterId === m.characterId
                );
                return {
                  characterId: m.characterId,
                  characterName: char?.name ?? m.characterId,
                  talentId: m.talentId,
                  talentName: m.talentName,
                };
              }),
            }
          );
        }

        return matches;
      }
    );

    return {
      matches: talentCharacterMatches,
    };
  }
}
