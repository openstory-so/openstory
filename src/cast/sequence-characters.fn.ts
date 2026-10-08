/**
 * Sequence Characters Server Functions
 * Functions for sequence-specific character (talent) operations
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { isValidTextToImageModel } from '@/models/models';
import { markPreviewUnusable, previewListWithChosenTake } from '@/cast/voice';
import { characterBibleFieldsSchema } from './bible-field';
import {
  attachLibraryCharacter,
  createCharacter,
  deleteCharacter,
  requireCharacter,
  restoreCharacter,
  selectCharacterVoiceVersion,
  setCharacterVoiceEnabled,
  updateCharacter,
} from '@/cast/server/cast-edit';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { releaseReplacedVoice } from '@/cast/server/voice/release-voice';
import { moveSequenceToCurrent } from '@/cast/server/version-moves';
import {
  getElevenLabsApiKey,
  isElevenLabsConfigured,
} from '@/models/server/elevenlabs-config';
import {
  elevenLabsDetail,
  elevenLabsStatus,
  isElevenLabsVoiceAlreadyCreated,
  isElevenLabsVoiceMissing,
  resolveAssignableVoiceId,
  saveDesignedVoice,
  type AssignableVoicePick,
} from '@/cast/server/voice/elevenlabs-voice';
import { voiceProviderOf, SEED_VOICE_MAX_TAKES } from '@/cast/seed-voice';
import { readLookSheetStaleness } from '@/cast/server/production-staleness';
import type { SheetStaleness } from '@/cast/server/sheets/sheet-staleness';

import { NotFoundError, ValidationError } from '@/platform/errors';
import {
  cancelCharacterVoice,
  generateCharacterVoice,
  recastCharacter,
  regenerateCharacterSheet,
} from '@/cast/server/cast-generation';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';

/** Get all characters for a sequence with their assigned talent */
export const getSequenceCharactersFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.characters.listWithTalent(context.sequence.id);
  });

// ============================================================================
// Manual character CRUD (#1108 Phase 2)
// ============================================================================

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
    const { sequenceId, ...fields } = data;
    return await createCharacter(
      context.scopedDb,
      { userId: context.user.id },
      sequenceId,
      fields
    );
  });

/**
 * Cast a library character into the sequence (#2050). Idempotent for a
 * character the sequence already casts; refused while a live cast member has
 * the same name.
 */
export const attachLibraryCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(z.object({ sequenceId: ulidSchema, characterId: ulidSchema }))
  )
  .handler(
    async ({ context, data }) =>
      await attachLibraryCharacter(
        context.scopedDb,
        { userId: context.user.id },
        data.sequenceId,
        data.characterId
      )
  );

/**
 * Edit a character's bible fields. Only provided fields change; prompts and
 * the character sheet that project them re-stale purely by hash derivation
 * (no flag written). Casting stays on `recastCharacterFn`. `voiceOnly` is
 * required (#1585): it is the way back from a bible call that misfiled an
 * on-screen character as a voice, so the form always states it.
 */
export const updateSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        characterId: ulidSchema,
        name: z.string().trim().min(1).max(255).optional(),
        voiceOnly: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, characterId, ...fields } = data;
    return await updateCharacter(
      context.scopedDb,
      { userId: context.user.id },
      sequenceId,
      characterId,
      fields
    );
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
    return await deleteCharacter(
      context.scopedDb,
      { userId: context.user.id },
      data.sequenceId,
      data.characterId
    );
  });

/**
 * Design (or re-design) a character's voice (#1553 / #1715). Inserts a
 * generating husk and keeps the current voice until that husk promotes.
 * A second Generate while a live husk exists no-ops (`alreadyInFlight`).
 */
export const generateCharacterVoiceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterIdInput.extend({
        takes: z.number().int().min(1).max(SEED_VOICE_MAX_TAKES),
      })
    )
  )
  .handler(({ context, data }) =>
    generateCharacterVoice(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence,
      data
    )
  );

/**
 * Cancel a voice still generating: the husk fails as cancelled and the
 * character keeps the voice it had. Data-only: the run is not terminated
 * (it may be a parent's awaited child, and a stop between save-voice and
 * persist-voice would leak the provider voice). It lands, finds its claim
 * no longer live, releases the voice and promotes nothing.
 */
export const cancelCharacterVoiceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(({ context, data }) =>
    cancelCharacterVoice(context.scopedDb, data.sequenceId, data.characterId)
  );

/**
 * Per-character voice switch (#1553): an explicit override of the sequence
 * default. Off releases the saved voice.
 */
export const setCharacterVoiceEnabledFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput.extend({ enabled: z.boolean() })))
  .handler(async ({ context, data }) => {
    return await setCharacterVoiceEnabled(
      context.scopedDb,
      { userId: context.user.id },
      data.sequenceId,
      data.characterId,
      data.enabled
    );
  });

/**
 * Make one of the parked Voice Design takes the saved voice (#1553). Order:
 * save the take, write the row, then release the old voice — a failed save
 * leaves the row untouched, and a failed release leaves the new id on the
 * row with the old one still on the account for the next release to retry
 * (never two slots with no pointer). The chosen take moves to the front:
 * while `voiceId` is set, `voicePreviews[0]` is the saved voice. Take
 * numbers are stamped (and kept) so the In use card can show Take 2
 * after promoting the second preview (#1709). A gone preview is HTTP 400
 * `voice_not_found` (not 404); any other 4xx carries the provider's
 * reason (already created, slot limit, description rejected).
 */
export const chooseCharacterVoiceTakeFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(characterIdInput.extend({ generatedVoiceId: z.string() }))
  )
  .handler(async ({ context, data }) => {
    const character = await requireCharacter(
      context.scopedDb,
      data.sequenceId,
      data.characterId
    );
    const previews = previewListWithChosenTake(
      character.voicePreviews ?? [],
      data.generatedVoiceId
    );
    const take = previews?.[0];
    if (!previews || !take) throw new NotFoundError('Take not found');
    if (
      character.voicePreviews?.[0]?.generatedVoiceId ===
        take.generatedVoiceId &&
      character.voiceId
    ) {
      return { characterId: character.id, voiceId: character.voiceId };
    }
    if (take.unusable === 'expired') {
      throw new ValidationError(
        'This take has expired. Regenerate the voice for fresh takes.'
      );
    }
    if (take.unusable === 'saved') {
      throw new ValidationError(
        'This take was already saved. Regenerate the voice for fresh takes.'
      );
    }
    // A Seed take IS its voice (#1765): nothing to save, no slot to spend.
    if (voiceProviderOf(take.generatedVoiceId) === 'seed') {
      await context.scopedDb.characters.updateVoice(
        data.sequenceId,
        character.id,
        { voiceId: take.generatedVoiceId, voicePreviews: previews },
        'generated',
        context.user.id
      );
      await releaseReplacedVoice(
        context.scopedDb,
        character.voiceId,
        take.generatedVoiceId
      );
      return { characterId: character.id, voiceId: take.generatedVoiceId };
    }
    const apiKey = getElevenLabsApiKey();
    if (!apiKey || !isElevenLabsConfigured()) {
      throw new ValidationError('Voice design is not configured');
    }
    let voiceId: string;
    try {
      voiceId = await saveDesignedVoice(apiKey, {
        voiceName: `${character.name} · ${character.sequenceId.slice(-6)}`,
        voiceDescription: character.voiceDescription ?? '',
        generatedVoiceId: take.generatedVoiceId,
      });
    } catch (error) {
      const status = elevenLabsStatus(error);
      if (isElevenLabsVoiceMissing(error)) {
        await context.scopedDb.characters.stampPreviewUnusable(
          character.id,
          take.generatedVoiceId,
          'expired'
        );
        throw new ValidationError(
          'This take has expired. Regenerate the voice for fresh takes.'
        );
      }
      if (isElevenLabsVoiceAlreadyCreated(error)) {
        await context.scopedDb.characters.stampPreviewUnusable(
          character.id,
          take.generatedVoiceId,
          'saved'
        );
        throw new ValidationError(
          'This take was already saved. Regenerate the voice for fresh takes.'
        );
      }
      // 429 is not the user's doing and clears on retry, so it stays a
      // plain error rather than a "could not save" verdict.
      if (
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 429
      ) {
        throw new ValidationError(
          `Could not save this take: ${elevenLabsDetail(error) ?? `ElevenLabs returned ${status}`}`
        );
      }
      throw error;
    }
    await context.scopedDb.characters.updateVoice(
      data.sequenceId,
      character.id,
      {
        voiceId,
        voicePreviews:
          markPreviewUnusable(previews, take.generatedVoiceId, 'saved') ??
          previews,
      },
      'generated',
      context.user.id
    );
    await releaseReplacedVoice(context.scopedDb, character.voiceId, voiceId);
    return { characterId: character.id, voiceId };
  });

/**
 * Assign a premade or Voice Library voice (#1629). Premade ids are used
 * as-is (no slot). Library voices are copied onto the platform account,
 * then the old designed/library slot is released. Designed takes stay
 * parked so the user can switch back.
 */
export const assignCharacterVoiceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterIdInput.extend({
        source: z.enum(['premade', 'library']),
        voiceId: z.string().min(1).max(128),
        publicOwnerId: z.string().min(1).max(128).optional(),
        name: z.string().trim().min(1).max(255).optional(),
        description: z.string().trim().max(2000).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const apiKey = getElevenLabsApiKey();
    if (!apiKey || !isElevenLabsConfigured()) {
      throw new ValidationError('Voice design is not configured');
    }
    const character = await requireCharacter(
      context.scopedDb,
      data.sequenceId,
      data.characterId
    );
    let pick: AssignableVoicePick;
    if (data.source === 'library') {
      if (!data.publicOwnerId || !data.name) {
        throw new ValidationError(
          'Library voices need a public owner id and a name'
        );
      }
      pick = {
        source: 'library',
        voiceId: data.voiceId,
        publicOwnerId: data.publicOwnerId,
        name: `${data.name} · ${character.name}`,
      };
    } else {
      pick = { source: 'premade', voiceId: data.voiceId };
    }
    let voiceId: string;
    try {
      voiceId = await resolveAssignableVoiceId(apiKey, pick);
    } catch (error) {
      const status = elevenLabsStatus(error);
      if (isElevenLabsVoiceMissing(error)) {
        throw new ValidationError('This voice is no longer available.');
      }
      if (
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 429
      ) {
        throw new ValidationError(
          `Could not use this voice: ${elevenLabsDetail(error) ?? `ElevenLabs returned ${status}`}`
        );
      }
      throw error;
    }
    if (character.voiceId === voiceId) {
      return { characterId: character.id, voiceId };
    }
    const voiceDescription = (data.description ?? data.name)?.trim();
    await context.scopedDb.characters.updateVoice(
      data.sequenceId,
      character.id,
      { voiceId, ...(voiceDescription ? { voiceDescription } : {}) },
      'library',
      context.user.id
    );
    await releaseReplacedVoice(context.scopedDb, character.voiceId, voiceId);
    return { characterId: character.id, voiceId };
  });

/**
 * Voice history (#1657): every voice this character has held, newest first.
 * `characters.selectedVoiceVersionId` names the live one; a row carrying `releasedAt`
 * names an id that no longer exists at ElevenLabs and can never come back.
 */
export const listCharacterVoiceVersionsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(async ({ context, data }) => {
    const character = await requireCharacter(
      context.scopedDb,
      data.sequenceId,
      data.characterId
    );
    return await context.scopedDb.characters.listVoiceVersions(character.id);
  });

/**
 * Point the character back at an earlier voice (#1657). Same order as
 * choosing a take: the pointer moves first, then the voice the
 * row was holding is released if nothing else uses it. A failed release is
 * logged, not thrown (`releaseReplacedVoice`): the switch already happened.
 * A release stamps the old id's history rows, which is why a voice, once
 * released, can never be selected again.
 */
export const selectCharacterVoiceVersionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput.extend({ versionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    return await selectCharacterVoiceVersion(
      context.scopedDb,
      data.sequenceId,
      data.characterId,
      data.versionId
    );
  });

/**
 * "Update this sequence" (#2017): move this sequence's cast link to the
 * character's current bible, voice and look versions. A pointer write; the
 * sequence's sheets and shots then read stale and its own Update redraws them.
 */
export const updateCastToCurrentFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(
    async ({ context, data }) =>
      await moveSequenceToCurrent(
        context.scopedDb,
        { userId: context.user.id },
        data.sequenceId,
        data.characterId
      )
  );

/**
 * "Make a one-off copy" (#2017): a new character from the version this
 * sequence pins, this sequence's cast link repointed at it. Free: the copy
 * keeps pointing at the original's sheet rows, so nothing re-renders.
 */
export const copyCharacterForSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(
    async ({ context, data }) =>
      await context.scopedDb.characters.copyForSequence(
        data.sequenceId,
        data.characterId,
        { actorId: context.user.id }
      )
  );

/** Undo a character soft-delete. */
export const restoreSequenceCharacterFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterIdInput))
  .handler(async ({ context, data }) => {
    return await restoreCharacter(
      context.scopedDb,
      { userId: context.user.id },
      data.sequenceId,
      data.characterId
    );
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
        // A look other than the character's default (#2015).
        lookId: ulidSchema.optional(),
        imageModel: z
          .string()
          .refine(isValidTextToImageModel, {
            message: 'Invalid image model',
          })
          .optional(),
      })
    )
  )
  .handler(({ context, data }) =>
    regenerateCharacterSheet(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence,
      // No look named: the default look, whose id is the character's.
      { ...data, lookId: data.lookId ?? data.characterId }
    )
  );

/** Live sheet staleness for the character detail banner. */
export const getCharacterSheetStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(characterIdInput.extend({ lookId: ulidSchema.optional() }))
  )
  .handler(
    async ({ context, data }): Promise<SheetStaleness> =>
      (
        await readLookSheetStaleness(
          context.scopedDb,
          data.sequenceId,
          data.characterId,
          data.lookId ?? data.characterId
        )
      ).status
  );

/**
 * Recast a character with different talent, triggering sheet regeneration.
 * `applyToSequenceIds`: the other sequences to move to the recast version
 * (#2017); the rest keep theirs.
 */
export const recastCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        characterId: z.string().min(1),
        talentId: ulidSchema,
        applyToSequenceIds: z.array(ulidSchema),
      })
    )
  )
  .handler(({ context, data }) =>
    recastCharacter(context.scopedDb, { userId: context.user.id }, data)
  );
