/**
 * The `characterBibleWorkflow` durable workflow.
 *
 * Fans out to the `CharacterSheetWorkflow` child via Pattern 3
 * (`spawnAndAwaitChild`) rather than generating each sheet inline, so the
 * parent stays thin and every child gets its own retry budget. See
 * await-child.ts.
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { CharacterMinimal } from '@/platform/server/db/schema';
import { buildCharacterInsert } from './cast-records';
import { buildCastingAttributes } from '@/cast/character-prompt';
import { reusesTalentSheet } from '@/cast/server/talent/reuse-talent-sheet';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { contentRejectionSummary } from '@/models/content-rejection';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  CharacterBibleWorkflowInput,
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  TalentCharacterMatch,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'character-bible']);

const PARENT_BINDING_NAME = 'CHARACTER_BIBLE_WORKFLOW';

export class CharacterBibleWorkflow extends OpenStoryWorkflowEntrypoint<CharacterBibleWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<CharacterMinimal[]> {
    const input = event.payload;
    const { talentMatches = [] } = input;

    // Create lookup map for talent matches
    const matchMap = new Map<string, TalentCharacterMatch>(
      talentMatches.map((m) => [m.characterId, m])
    );

    // Step 1: Insert character records into the database. Always runs, so a
    // resumed run finds its rows already present.
    const createdCharacters = await step.do(
      'create-character-records',
      async () => {
        if (!input.sequenceId || !input.userId || !input.teamId) {
          return [];
        }

        // Upsert on (sequenceId, characterId): the Script stage already
        // created these rows sheet-less, so this keeps their ids and flips
        // them to `generating`. A voice-only character (#1585) is completed
        // by design with no sheet version, so nothing waits on it — unlike
        // the #939 case, which was a FAILED sheet left `completed`.
        const results: Array<{ id: string; characterId: string }> = [];
        for (const character of input.characterBible) {
          const created = await scopedDb.characters.create(
            buildCharacterInsert({
              sequenceId: input.sequenceId,
              character,
              talentMatch: matchMap.get(character.characterId),
              sheetStatus: character.voiceOnly ? 'completed' : 'generating',
            })
          );
          results.push({ id: created.id, characterId: created.characterId });
        }
        return results;
      }
    );

    if (input.characterBible.length === 0) {
      return [];
    }

    // Create mapping from characterId to database id
    const characterIdToDbId = new Map<string, string>(
      createdCharacters.map((c) => [c.characterId, c.id])
    );

    const characterSheetBinding = this.env.CHARACTER_SHEET_WORKFLOW;

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Voice-only characters get no child: nothing to draw (#1585).
    const sheetCharacters = input.characterBible.filter((c) => !c.voiceOnly);
    const voiceOnlyCharacters = input.characterBible.filter((c) => c.voiceOnly);
    if (voiceOnlyCharacters.length > 0) {
      logger.info(
        `[CharacterBibleWorkflow:cf] Skipping sheets for ${voiceOnlyCharacters.length} voice-only character(s): ` +
          voiceOnlyCharacters.map((c) => c.name).join(', ')
      );
    }

    // Step 2: Fan out one CharacterSheetWorkflow child per on-screen character. Spawns
    // happen in parallel via Promise.all; the awaits use Promise.allSettled
    // so a single timed-out child does not tank the entire parent run.
    const spawnPromises = sheetCharacters.map(async (character, index) => {
      const characterDbId = characterIdToDbId.get(character.characterId);
      if (!characterDbId) {
        throw new WorkflowValidationError(
          `[CharacterBibleWorkflow:cf] No DB id found for character ${character.characterId}; ` +
            `create-character-records did not return a matching row`
        );
      }

      const talentMatch = matchMap.get(character.characterId);
      const castingAttrs = talentMatch
        ? buildCastingAttributes(character, {
            sheetMetadata: talentMatch.sheetMetadata,
            talentName: talentMatch.talentName,
            personality: talentMatch.personality,
            movement: talentMatch.movement,
          })
        : null;

      // Shared with the reservation gate, which counts the sheets that will
      // actually be billed — see `reusesTalentSheet`.
      const reuseTalentSheet = reusesTalentSheet(character, talentMatch);

      const childPayload: CharacterSheetWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId: input.sequenceId,
        reservationId: input.reservationId,
        characterDbId,
        characterName: character.name,
        characterMetadata: character,
        imageModel,
        referenceImageUrl: talentMatch?.sheetImageUrl,
        talentMetadata: talentMatch?.sheetMetadata,
        // Image-anchored, name-free: naming a person + "look exactly like"
        // trips OpenAI's real-person likeness moderation (see
        // buildCastingAttributes).
        talentDescription: talentMatch
          ? 'This character must exactly match the person shown in the reference image'
          : undefined,
        reuseTalentSheet,
        styleConfig: input.styleConfig,
      };

      const childResult = await spawnAndAwaitChild<
        CharacterSheetWorkflowInput,
        CharacterSheetWorkflowResult
      >(step, {
        binding: characterSheetBinding,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId: event.instanceId,
        childId: `character-sheet:${characterDbId}`,
        childPayload,
        spawnStepName: `spawn-character-sheet-${index}`,
        awaitStepName: `await-character-sheet-${index}`,
        timeout: '30 minutes',
      });

      return {
        character,
        castingAttrs,
        characterDbId,
        childResult,
      };
    });

    const settled = await Promise.allSettled(spawnPromises);

    const seqCharacters: CharacterMinimal[] = [];
    const failures: { name: string; reason: string }[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        // A reference sheet is what anchors a character's identity across cuts
        // (#801), and every character in the bible recurs by construction — so
        // a missing sheet means the sequence would render an unanchored,
        // different-looking person each cut. We therefore do NOT swallow a
        // failed child and press on (the old behaviour, which left the row
        // `completed` with a null sheet and silently continued); instead we
        // collect every failure and throw once below so the parent
        // (analyze-script) fails the whole sequence with a clear status error
        // rather than completing it unanchored (#939). The child's own
        // `onFailure` already wrote the failed status + emitted the realtime
        // event for the affected character row.
        const character = sheetCharacters[index];
        const name = character?.name ?? `index ${index}`;
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        logger.error(
          `[CharacterBibleWorkflow:cf] Child character-sheet failed for ${name}:`,
          {
            err: outcome.reason,
          }
        );
        failures.push({ name, reason });
        continue;
      }

      const { character, castingAttrs, characterDbId, childResult } =
        outcome.value;

      seqCharacters.push({
        id: characterDbId,
        characterId: character.characterId,
        name: character.name,
        sheetImageUrl: childResult.sheetImageUrl,
        sheetStatus: 'completed' as const,
        sheetInputHash: null,
        selectedSheetVersionId: childResult.sheetVersionId ?? null,
        physicalDescription:
          castingAttrs?.physicalDescription ?? character.physicalDescription,
        voiceOnly: false,
        consistencyTag:
          castingAttrs?.consistencyTag ?? character.consistencyTag,
      });
    }

    for (const character of voiceOnlyCharacters) {
      const characterDbId = characterIdToDbId.get(character.characterId);
      if (!characterDbId) {
        throw new WorkflowValidationError(
          `[CharacterBibleWorkflow:cf] No DB id found for voice-only character ${character.characterId}; ` +
            `create-character-records did not return a matching row`
        );
      }
      seqCharacters.push({
        id: characterDbId,
        characterId: character.characterId,
        name: character.name,
        sheetImageUrl: null,
        sheetStatus: 'completed' as const,
        sheetInputHash: null,
        selectedSheetVersionId: null,
        physicalDescription: character.physicalDescription,
        voiceOnly: true,
        consistencyTag: character.consistencyTag,
      });
    }

    if (failures.length > 0) {
      // Stop the sequence rather than continue with an unanchored character
      // (#939). This rejection propagates up through `spawnAndAwaitChild` to
      // analyze-script's `charSettled.status === 'rejected'` branch, which marks
      // the sequence `failed` with this message and emits `generation.failed`.
      // Content-only failures collapse to the names so the banner can list
      // who was blocked (#1293).
      throw new Error(
        contentRejectionSummary(failures) ??
          `Character sheet generation failed for ${failures.length} of ${settled.length} character(s); ` +
            `stopping rather than rendering an unanchored sequence: ${failures.map((f) => `${f.name} (${f.reason})`).join('; ')}`
      );
    }

    return seqCharacters;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    logger.error(
      `[CharacterBibleWorkflow:cf] Character sheet generation failed: ${error}`
    );
  }
}
