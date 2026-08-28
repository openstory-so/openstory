/**
 * Sequence Characters Server Functions
 * Functions for sequence-specific character (talent) operations
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { isValidTextToImageModel, safeTextToImageModel } from '@/lib/ai/models';
import type { CharacterBibleUpdate } from '@/lib/db/scoped/characters';
import { resolveSequenceStyleConfig } from '@/lib/style/style-config';
import { buildCastingAttributes } from '@/lib/prompts/character-prompt';
import { shouldReuseTalentSheet } from '@/lib/talent/reuse-talent-sheet';
import { getGenerationChannel } from '@/lib/realtime';
import {
  bibleField,
  identityToken,
  nextIdentityToken,
  slugifyTag,
} from '@/lib/schemas/bible-field';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { RecastCharacterWorkflowInput } from '@/lib/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/lib/workflows/recast-snapshot';
import { buildRegenerateCharacterSheetPayload } from '@/lib/sheets/character-sheet-trigger';
import type { SheetStaleness } from '@/lib/sheets/sheet-staleness';
import { characterSheetHashMatchesStored } from '@/lib/workflows/sheet-snapshots';

import { NotFoundError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

const logger = getLogger(['openstory', 'serverFn', 'sequence-characters']);

/**
 * Recast accepts talents owned by the requesting team OR public talents.
 * Mirrors the read-side ACL in `talent.getWithRelations`. Extracted for unit
 * testing because this is a permission boundary and silent regressions here
 * would let one team trigger recasts using another team's private talent.
 */
export function assertTalentAccessible(
  talent: { teamId: string; isPublic: boolean | null },
  contextTeamId: string
): void {
  if (talent.teamId !== contextTeamId && !talent.isPublic) {
    throw new Error('Talent does not belong to your team');
  }
}

/** Get all characters for a sequence with their assigned talent */
export const getSequenceCharactersFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.characters.listWithTalent(context.sequence.id);
  });

// ============================================================================
// Manual character CRUD (#1108 Phase 2)
// ============================================================================

const characterBibleFieldsSchema = z.object({
  age: bibleField.optional(),
  gender: bibleField.optional(),
  ethnicity: bibleField.optional(),
  physicalDescription: bibleField.optional(),
  standardClothing: bibleField.optional(),
  distinguishingFeatures: bibleField.optional(),
  consistencyTag: bibleField.optional(),
});

/**
 * Create a character by hand (no storyboard run) — starts sheet-less
 * (`sheetStatus: 'pending'`); the sheet comes later via the existing recast /
 * sheet workflows. `characterId` is a shortened name (`char_maya`) in the
 * same family as script-extracted `char_001` / `char_girl_one`, uniqued
 * against existing rows on the `(sequenceId, characterId)` index.
 */
export const createSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        name: z.string().trim().min(1).max(255),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, name, ...bible } = data;
    const base = identityToken('char', name);
    const taken = new Set<string>();
    let characterId = base;
    // Unique index covers soft-deleted rows too.
    while (
      await context.scopedDb.characters.getByCharacterId(
        sequenceId,
        characterId
      )
    ) {
      taken.add(characterId);
      characterId = nextIdentityToken(base, taken);
    }
    const character = await context.scopedDb.characters.create({
      sequenceId,
      characterId,
      name,
      ...bible,
      consistencyTag:
        bible.consistencyTag ?? `${characterId}: ${slugifyTag(name)}`,
      sheetStatus: 'pending',
    });
    await context.scopedDb.sequenceEvents.record({
      sequenceId,
      actorId: context.user.id,
      kind: 'character.created',
      targetType: 'character',
      targetId: character.id,
      summary: `Added character ${name}`,
      data: { name, characterId },
    });
    return character;
  });

/**
 * Edit a character's bible fields. Only provided fields change; prompts and
 * the character sheet that project them re-stale purely by hash derivation
 * (no flag written). Casting stays on `recastCharacterFn`.
 */
export const updateSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        characterId: ulidSchema,
        name: z.string().trim().min(1).max(255).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, characterId, ...fields } = data;
    const existing = await context.scopedDb.characters.getById(characterId);
    if (!existing || existing.sequenceId !== sequenceId) {
      throw new NotFoundError('Character not found');
    }
    const update: CharacterBibleUpdate = fields;
    return await context.scopedDb.characters.updateBible(characterId, update, {
      actorId: context.user.id,
    });
  });

const characterIdInput = z.object({
  sequenceId: ulidSchema,
  characterId: ulidSchema,
});

/**
 * Soft-remove a character (undoable; toast Undo calls the restore fn). Scene
 * continuity tags are NOT stripped — undo is lossless; prompts referencing
 * the character read stale because the bible reads exclude deleted rows.
 */
export const softDeleteSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(async ({ context, data }) => {
    const existing = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!existing || existing.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Character not found');
    }
    const deletedAt = await context.scopedDb.characters.softDelete(
      data.characterId,
      { actorId: context.user.id }
    );
    return { characterId: data.characterId, deletedAt };
  });

/** Undo a character soft-delete. */
export const restoreSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(async ({ context, data }) => {
    const existing = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!existing || existing.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Character not found');
    }
    return await context.scopedDb.characters.restore(data.characterId, {
      actorId: context.user.id,
    });
  });

/** Get shot IDs for all shots containing a specific character */
export const getShotIdsForCharacterFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ characterId: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const shotIds = await context.scopedDb.characters.getShotIdsForCharacter(
      context.sequence.id,
      data.characterId
    );
    return { shotIds, count: shotIds.length };
  });

/**
 * Regenerate the character sheet from the current bible. Does not recast
 * talent, does not regenerate shots — stills go stale by derivation once
 * the new version is selected.
 */
export const regenerateCharacterSheetFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterIdInput.extend({
        imageModel: z
          .string()
          .refine(isValidTextToImageModel, {
            message: 'Invalid image model',
          })
          .optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character || character.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Character not found');
    }

    const payload = await buildRegenerateCharacterSheetPayload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      teamId: context.teamId,
      sequence: context.sequence,
      character,
      imageModel: data.imageModel,
    });

    await context.scopedDb.characters.updateSheetStatus(
      character.id,
      'generating'
    );
    try {
      await getGenerationChannel(character.sequenceId).emit(
        'generation.character-sheet:progress',
        { characterId: character.id, status: 'generating' }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    let workflowRunId: string;
    try {
      workflowRunId = await triggerWorkflow('/character-sheet', payload, {
        label: buildWorkflowLabel(character.sequenceId),
        // Explicit regen must not reuse the bible-child id
        // `character-sheet:${id}` — that instance is already complete, and CF
        // would no-op a second Generate (sheetStatus stuck at generating).
        // Same pattern as generateTalentSheetFn: omit dedup so each click is a
        // new run.
      });
    } catch (error) {
      await context.scopedDb.characters.updateSheetStatus(
        character.id,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    return { characterId: character.id, workflowRunId };
  });

/** Live sheet staleness for the character detail banner. */
export const getCharacterSheetStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(async ({ context, data }): Promise<SheetStaleness> => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character || character.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Character not found');
    }
    if (character.sheetStatus === 'generating') return 'generating';
    if (character.sheetInputHash == null) return 'untracked';

    const payload = await buildRegenerateCharacterSheetPayload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      teamId: context.teamId,
      sequence: context.sequence,
      character,
    });
    if (!payload.snapshotInputHash) return 'untracked';
    return (await characterSheetHashMatchesStored(
      character.sheetInputHash,
      payload
    ))
      ? 'fresh'
      : 'stale';
  });

/** Recast a character with different talent, triggering sheet regeneration */
export const recastCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({ characterId: z.string().min(1), talentId: ulidSchema })
    )
  )
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character) {
      throw new NotFoundError('Character not found');
    }

    // Fetch the sequence's style for character sheet generation
    const sequence = await context.scopedDb.sequences.getForUser({
      sequenceId: character.sequenceId,
    });
    const style =
      sequence.styleConfig == null && sequence.styleId
        ? await context.scopedDb.styles.getById(sequence.styleId)
        : null;
    const styleConfig =
      sequence.styleConfig != null || style
        ? resolveSequenceStyleConfig({
            snapshot: sequence.styleConfig,
            live: style?.config,
          })
        : undefined;

    const talentWithSheets = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );
    if (!talentWithSheets) {
      throw new Error('Talent not found');
    }
    assertTalentAccessible(talentWithSheets, context.teamId);

    // Filter divergent sheets out of the fallback chain — they are stale-
    // marked variants and must not back the talent's casting identity.
    const defaultSheet =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentWithSheets.sheets?.find((s) => s.isDefault && !s.divergedAt) ??
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentWithSheets.sheets?.find((s) => !s.divergedAt);

    // Merge talent appearance with character role attributes
    const castingAttrs = buildCastingAttributes(
      {
        characterId: character.characterId,
        name: character.name,
        age: character.age ?? '',
        gender: character.gender ?? '',
        ethnicity: character.ethnicity ?? '',
        physicalDescription: character.physicalDescription ?? '',
        standardClothing: character.standardClothing ?? '',
        distinguishingFeatures: character.distinguishingFeatures ?? '',
        consistencyTag: character.consistencyTag ?? '',
      },
      {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        sheetMetadata: defaultSheet?.metadata ?? undefined,
        talentName: talentWithSheets.name,
        talentDescription: talentWithSheets.description ?? undefined,
      }
    );

    // Update talent assignment AND physical attributes from talent
    await context.scopedDb.characters.updateTalent(
      data.characterId,
      data.talentId
    );
    const updatedCharacter = await context.scopedDb.characters.update(
      data.characterId,
      {
        age: castingAttrs.age,
        gender: castingAttrs.gender,
        ethnicity: castingAttrs.ethnicity,
        physicalDescription: castingAttrs.physicalDescription,
        consistencyTag: castingAttrs.consistencyTag,
      }
    );

    const affectedShotIds =
      await context.scopedDb.characters.getShotIdsForCharacter(
        character.sequenceId,
        data.characterId
      );

    // Always generate a character sheet showing the talent in costume
    await context.scopedDb.characters.updateSheetStatus(
      data.characterId,
      'generating'
    );

    await getGenerationChannel(character.sequenceId).emit(
      'generation.character-sheet:progress',
      { characterId: data.characterId, status: 'generating' }
    );

    // Freeze every regenerate-shots input here, at the trigger. The workflow
    // used to rebuild this after its sheet child finished — eight live reads
    // against state the user never authorised.
    const imageModel = safeTextToImageModel(sequence.imageModel);
    const { shotSnapshots, snapshotInputHash } =
      await buildRecastRegenerateSnapshots({
        scopedDb: context.scopedDb,
        sequenceId: character.sequenceId,
        shotIds: affectedShotIds,
        imageModel,
        aspectRatio: sequence.aspectRatio,
        subject: { kind: 'character', character: updatedCharacter },
      });

    const workflowInput: RecastCharacterWorkflowInput = {
      characterDbId: data.characterId,
      characterName: character.name,
      characterMetadata: {
        characterId: character.characterId,
        name: character.name,
        ...castingAttrs,
      },
      sequenceId: character.sequenceId,
      teamId: context.teamId,
      userId: context.user.id,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      referenceImageUrl: defaultSheet?.imageUrl ?? undefined,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentMetadata: defaultSheet?.metadata ?? undefined,
      // Image-anchored, name-free (see buildCastingAttributes): naming a
      // person + "look exactly like" trips OpenAI's likeness moderation.
      talentDescription:
        `This character must exactly match the person shown in the reference image. ${talentWithSheets.description ?? ''}`.trim(),
      reuseTalentSheet: Boolean(
        defaultSheet?.imageUrl &&
        shouldReuseTalentSheet({
          characterClothing: character.standardClothing,
          characterFeatures: character.distinguishingFeatures,
          talentClothing: defaultSheet.metadata?.standardClothing,
          talentFeatures: defaultSheet.metadata?.distinguishingFeatures,
          talentPhysical: defaultSheet.metadata?.physicalDescription,
          talentDescription: talentWithSheets.description,
        })
      ),
      imageModel,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentSheetInputHash: defaultSheet?.inputHash ?? null,
      styleConfig,
      aspectRatio: sequence.aspectRatio,
      shotSnapshots,
      snapshotInputHash,
    };

    const workflowRunId = await triggerWorkflow(
      '/recast-character',
      workflowInput,
      { label: buildWorkflowLabel(character.sequenceId) }
    );

    return {
      character: updatedCharacter,
      talentId: data.talentId,
      sheetWorkflowRunId: workflowRunId,
      // The shots actually queued — a shot with no selected image prompt is
      // dropped by the snapshot builder rather than failing the recast.
      affectedShotIds: shotSnapshots.map((s) => s.shotId),
    };
  });
