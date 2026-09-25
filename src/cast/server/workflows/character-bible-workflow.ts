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
import { isPersonFromTalentCast } from '@/cast/likeness';
import { reusesTalentSheet } from '@/cast/server/talent/reuse-talent-sheet';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { contentRejectionSummary } from '@/models/content-rejection';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  CharacterBibleWorkflowInput,
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  CharacterVoiceWorkflowInput,
  CharacterVoiceWorkflowResult,
  TalentCharacterMatch,
} from '@/platform/server/workflow/types';
import { SEED_VOICE_DEFAULT_TAKES } from '@/cast/seed-voice';
import { usesVoice } from '@/cast/voice';
import { newVoiceProvider } from '@/models/server/seed-speech-config';
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
        // by design with no sheet version, so nothing waits on it. A failed
        // sheet stays `failed` on the row; the parent stays at Casting (#1727).
        // The upsert's returned row is the one read of live state here: it
        // says whether the character already holds a voice (never design a
        // second — a saved voice is an account-wide slot) and whether the
        // user switched voices off for it while the run was stopped.
        const results: Array<{
          id: string;
          characterId: string;
          voiceId: string | null;
          voiceDescription: string | null;
          useVoice: boolean | null;
        }> = [];
        for (const character of input.characterBible) {
          const created = await scopedDb.characters.create(
            buildCharacterInsert({
              sequenceId: input.sequenceId,
              character,
              talentMatch: matchMap.get(character.characterId),
              sheetStatus: character.voiceOnly ? 'completed' : 'generating',
            })
          );
          results.push({
            id: created.id,
            characterId: created.characterId,
            voiceId: created.voiceId,
            voiceDescription: created.voiceDescription,
            useVoice: created.useVoice,
          });
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
        castTalentDescription: talentMatch?.talentDescription ?? null,
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

    // Voices (#1553 / #1715) ride alongside the sheets: insert a generating
    // husk, then spawn one child per speaking character that resolves
    // `usesVoice()` true and has none yet. A failed child is logged (its own
    // `onFailure` emitted the realtime `failed` event for the card) and the
    // run goes on — that character's lines just have no designed voice for
    // dialogue TTS (#1554). If spawn never starts, this parent fails the husk.
    const sequenceId = input.sequenceId;
    const voiceByCharacterId = new Map<string, string>();
    for (const row of createdCharacters) {
      if (row.voiceId) voiceByCharacterId.set(row.characterId, row.voiceId);
    }
    const voicePromises = createdCharacters
      .filter(
        (row) =>
          sequenceId !== undefined &&
          input.speakingCharacterIds.includes(row.characterId) &&
          usesVoice(row, { generateVoices: input.generateVoices }) &&
          !row.voiceId
      )
      .map(async (row) => {
        const character = input.characterBible.find(
          (c) => c.characterId === row.characterId
        );
        if (!character || sequenceId === undefined) return;
        let huskId: string | undefined;
        try {
          const claim = await step.do(
            `mark-voice-generating-${row.characterId}`,
            async () =>
              await scopedDb.characters.createPendingVoiceClaim(
                row.id,
                input.userId
              )
          );
          huskId = claim.version.id;
          if (!claim.created && claim.version.workflowRunId) {
            return;
          }
          const childPayload: CharacterVoiceWorkflowInput = {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            reservationId: input.reservationId,
            characterDbId: row.id,
            characterBible: character,
            voiceDescription: row.voiceDescription ?? '',
            analysisModelId: input.analysisModelId,
            voiceProvider: newVoiceProvider(),
            takes: SEED_VOICE_DEFAULT_TAKES,
            targetVersionId: claim.version.id,
          };
          const result = await spawnAndAwaitChild<
            CharacterVoiceWorkflowInput,
            CharacterVoiceWorkflowResult
          >(step, {
            binding: this.env.CHARACTER_VOICE_WORKFLOW,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId: event.instanceId,
            childId: `character-voice:${row.id}`,
            childPayload,
            spawnStepName: `spawn-character-voice-${row.characterId}`,
            awaitStepName: `await-character-voice-${row.characterId}`,
            timeout: '30 minutes',
          });
          if (result.voiceId) {
            voiceByCharacterId.set(row.characterId, result.voiceId);
          }
        } catch (err) {
          logger.error(
            `[CharacterBibleWorkflow:cf] Child character-voice failed for ${character.name}:`,
            { err }
          );
          // Spawn never started → child onFailure will not run. Fail the
          // husk so the unique live claim does not block Generate.
          if (huskId) {
            await scopedDb.characters.markVoiceClaimTerminal(
              huskId,
              'failed',
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      });

    const settled = await Promise.allSettled(spawnPromises);
    await Promise.all(voicePromises);

    const seqCharacters: CharacterMinimal[] = [];
    const failures: { name: string; reason: string }[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        // Keep the sibling sheets and let the parent stay at Casting so the
        // user can retry the misses (#1727). The child's `onFailure` already
        // wrote `failed` on the row and emitted the realtime event.
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
        if (!character) continue;
        const characterDbId = characterIdToDbId.get(character.characterId);
        if (!characterDbId) continue;
        seqCharacters.push({
          id: characterDbId,
          characterId: character.characterId,
          name: character.name,
          sheetImageUrl: null,
          sheetStatus: 'failed' as const,
          sheetInputHash: null,
          selectedSheetVersionId: null,
          physicalDescription: character.physicalDescription,
          voiceOnly: false,
          isPerson: isPersonFromTalentCast(
            character.isPerson,
            matchMap.get(character.characterId)?.hasSignedRelease
          ),
          voiceId: voiceByCharacterId.get(character.characterId) ?? null,
          consistencyTag: character.consistencyTag,
        });
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
        isPerson: isPersonFromTalentCast(
          character.isPerson,
          matchMap.get(character.characterId)?.hasSignedRelease
        ),
        voiceId: voiceByCharacterId.get(character.characterId) ?? null,
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
        isPerson: isPersonFromTalentCast(
          character.isPerson,
          matchMap.get(character.characterId)?.hasSignedRelease
        ),
        voiceId: voiceByCharacterId.get(character.characterId) ?? null,
        consistencyTag: character.consistencyTag,
      });
    }

    if (failures.length > 0) {
      logger.error(
        contentRejectionSummary(failures) ??
          `Character sheet generation failed for ${failures.length} of ${settled.length} character(s); ` +
            `staying at Casting so the user can retry: ${failures.map((f) => `${f.name} (${f.reason})`).join('; ')}`
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
