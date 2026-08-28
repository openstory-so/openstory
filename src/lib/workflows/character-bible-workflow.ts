/**
 * Cloudflare Workflows port of `characterBibleWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/character-bible-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original inlined the per-character sheet generation; this
 *     port fans out to the `CharacterSheetWorkflow` child via Pattern 3
 *     (`spawnAndAwaitChild`) so the parent stays thin and the children get
 *     their own retry budget. See await-child.ts.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { CharacterMinimal, NewCharacter } from '@/lib/db/schema';
import { buildCastingAttributes } from '@/lib/prompts/character-prompt';
import { shouldReuseTalentSheet } from '@/lib/talent/reuse-talent-sheet';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { contentRejectionSummary } from '@/lib/ai/content-rejection';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  CharacterBibleWorkflowInput,
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  TalentCharacterMatch,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

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

    // Step 1: Insert character records into database (always runs - mirrors
    // the QStash original which used this to satisfy the Upstash auth check).
    const createdCharacters = await step.do(
      'create-character-records',
      async () => {
        if (!input.sequenceId || !input.userId || !input.teamId) {
          return [];
        }

        const results: Array<{ id: string; characterId: string }> = [];
        for (const character of input.characterBible) {
          const talentMatch = matchMap.get(character.characterId);
          const castingAttrs = talentMatch
            ? buildCastingAttributes(character, {
                sheetMetadata: talentMatch.sheetMetadata,
                talentName: talentMatch.talentName,
              })
            : null;

          const created = await scopedDb.characters.create({
            id: generateId(),
            sequenceId: input.sequenceId,
            characterId: character.characterId,
            name: character.name,
            age: castingAttrs?.age ?? character.age,
            gender: castingAttrs?.gender ?? character.gender,
            ethnicity: castingAttrs?.ethnicity ?? character.ethnicity,
            physicalDescription:
              castingAttrs?.physicalDescription ??
              character.physicalDescription,
            standardClothing: character.standardClothing,
            distinguishingFeatures: character.distinguishingFeatures,
            consistencyTag:
              castingAttrs?.consistencyTag ?? character.consistencyTag,
            firstMentionSceneId: null,
            firstMentionText: null,
            firstMentionLine: null,
            sheetImageUrl: null,
            sheetImagePath: null,
            sheetStatus: 'generating' as const,
            talentId: talentMatch?.talentId ?? null,
          } satisfies NewCharacter);
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

    // Step 2: Fan out one CharacterSheetWorkflow child per character. Spawns
    // happen in parallel via Promise.all; the awaits use Promise.allSettled
    // so a single timed-out child does not tank the entire parent run.
    const spawnPromises = input.characterBible.map(async (character, index) => {
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
          })
        : null;

      const reuseTalentSheet = Boolean(
        talentMatch?.sheetImageUrl &&
        shouldReuseTalentSheet({
          characterClothing: character.standardClothing,
          characterFeatures: character.distinguishingFeatures,
          talentClothing: talentMatch.sheetMetadata?.standardClothing,
          talentFeatures: talentMatch.sheetMetadata?.distinguishingFeatures,
          talentPhysical: talentMatch.sheetMetadata?.physicalDescription,
          talentDescription: talentMatch.talentDescription,
        })
      );

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
        const character = input.characterBible[index];
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
        physicalDescription:
          castingAttrs?.physicalDescription ?? character.physicalDescription,
        consistencyTag:
          castingAttrs?.consistencyTag ?? character.consistencyTag,
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
