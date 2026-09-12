import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { deleteFile, getSignedUploadUrl, moveFile } from '#storage';
import { requireTeamAdminAccess } from '@/platform/server/auth/action-utils';
import { generateId } from '@/platform/id';
import {
  getPublicTalentWithRelations,
  listPublicTalent,
} from '@/platform/server/db/scoped';
import type { TalentWithSheets } from '@/platform/server/db/schema';
import {
  carryUploadRights,
  recordLikenessFinding,
  requireUploadRights,
} from '@/cast/server/upload-rights';
import { getRequest } from '@tanstack/react-start/server';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  createTalentSchema,
  createTalentSheetSchema,
  listTalentFilterSchema,
  updateTalentSchema,
} from '@/cast/server/talent.schemas';
import {
  STORAGE_BUCKETS,
  getPathFromUrl,
  getPublicUrl,
} from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import type { LibraryTalentSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { isTeamWritableTalent } from '@/cast/server/db/talent';
import { createLibraryTalent } from '@/cast/server/talent/create-library-talent';
import { analyzeTalentMediaForTeam } from '@/cast/server/talent/analyze-talent-media';
import { enqueueLibraryTalentSheet } from '@/cast/server/talent/enqueue-library-talent-sheet';
import { maybePromoteOrGenerateSheet } from '@/cast/server/talent/promote-or-generate-sheet';
import { isTeamTalentStoredUrl } from '@/platform/server/storage/copy-stored-image';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';

const talentIdSchema = z.object({ talentId: ulidSchema });
const sheetIdSchema = z.object({ sheetId: ulidSchema });
const mediaIdSchema = z.object({ mediaId: ulidSchema });
const characterIdSchema = z.object({ characterId: ulidSchema });

// List Talent

export const getTalentFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(listTalentFilterSchema.optional()))
  .handler(async ({ context, data }): Promise<TalentWithSheets[]> => {
    return context.scopedDb.talent.list({
      favoritesOnly: data?.favoritesOnly,
    });
  });

// List Public ("system") Talent — no auth, for anonymous visitors

export const getPublicTalentFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(listTalentFilterSchema.optional()))
  .handler(async ({ data }): Promise<TalentWithSheets[]> => {
    return listPublicTalent({ favoritesOnly: data?.favoritesOnly });
  });

// Get Single Talent

export const getTalentByIdFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    const talentRecord = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );

    if (!talentRecord) {
      throw new Error('Talent not found');
    }

    return talentRecord;
  });

// Get Single Public ("system") Talent — no auth, for anonymous visitors

export const getPublicTalentByIdFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(talentIdSchema))
  .handler(async ({ data }) => {
    const talentRecord = await getPublicTalentWithRelations(data.talentId);

    if (!talentRecord) {
      throw new Error('Talent not found');
    }

    return talentRecord;
  });

// Create Talent

export const createTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createTalentSchema))
  .handler(async ({ context, data }) => {
    return createLibraryTalent(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
    });
  });

// Update Talent

const updateTalentInputSchema = updateTalentSchema.extend({
  talentId: ulidSchema,
});

export const updateTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(updateTalentInputSchema))
  .handler(async ({ context, data }) => {
    const { talentId, ...updateData } = data;

    const updated = await context.scopedDb.talent.update(talentId, updateData);

    if (!updated) {
      throw new Error('Talent not found or you do not have permission');
    }

    return updated;
  });

// Delete Talent (requires admin/owner role)

export const deleteTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    await requireTeamAdminAccess(context.user.id, context.teamId);

    const deleted = await context.scopedDb.talent.delete(data.talentId);
    if (!deleted) {
      throw new Error(
        'Talent not found, is read-only, or you do not have permission to delete it'
      );
    }

    return { success: true };
  });

// Toggle Favorite

export const toggleTalentFavoriteFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    const updated = await context.scopedDb.talent.toggleFavorite(data.talentId);

    if (!updated) {
      throw new Error('Talent not found or you do not have permission');
    }

    return updated;
  });

// Create Talent Sheet

export const createTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createTalentSheetSchema))
  .handler(async ({ context, data }) => {
    return context.scopedDb.talent.sheets.create({
      talentId: data.talentId,
      name: data.name,
      imageUrl: data.imageUrl,
      imagePath: data.imagePath,
      metadata: data.metadata,
      isDefault: data.isDefault,
      source:
        data.source === 'ai_generated' ||
        data.source === 'manual_upload' ||
        data.source === 'script_analysis'
          ? data.source
          : 'manual_upload',
    });
  });

// Delete Talent Sheet

export const deleteTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => {
    const sheet = await context.scopedDb.talent.sheets.getById(data.sheetId);
    if (!sheet) {
      throw new Error('Sheet not found');
    }

    const deleted = await context.scopedDb.talent.sheets.delete(data.sheetId);
    if (!deleted) {
      throw new Error('Failed to delete sheet');
    }

    return { success: true };
  });

// Set Default Sheet

export const setDefaultSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => {
    const sheet = await context.scopedDb.talent.sheets.getById(data.sheetId);
    if (!sheet) {
      throw new Error('Sheet not found');
    }

    const updated = await context.scopedDb.talent.sheets.update(data.sheetId, {
      isDefault: true,
    });
    if (!updated) {
      throw new Error('Failed to update sheet');
    }

    return updated;
  });

// Delete Talent Media

export const deleteTalentMediaFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(mediaIdSchema))
  .handler(async ({ context, data }) => {
    const media = await context.scopedDb.talent.media.getById(data.mediaId);
    if (!media) {
      throw new Error('Media not found');
    }

    const deleted = await context.scopedDb.talent.media.delete(data.mediaId);
    if (!deleted) {
      throw new Error('Failed to delete media');
    }

    if (media.path) {
      try {
        await deleteFile(
          STORAGE_BUCKETS.TALENT,
          media.path.replace('talent/', '')
        );
      } catch {
        // Storage deletion is best-effort
      }
    }

    return { success: true };
  });

// Presigned Upload

const mediaTypeSchema = z.enum(['image', 'video', 'recording']);

/**
 * Every talent upload lands in `temp/` (#1581): finalize is what checks the
 * likeness ledger and moves the object under the talent, so the talent's
 * own folder only ever holds gated media and generated sheets.
 */
export const presignTalentUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        filename: z.string().min(1),
        type: mediaTypeSchema.optional(),
        talentId: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (data.talentId) {
      const talentRecord = await context.scopedDb.talent.getById(data.talentId);
      if (
        !talentRecord ||
        !isTeamWritableTalent(talentRecord, context.teamId)
      ) {
        throw new Error(
          'Talent not found or you do not have permission to modify it'
        );
      }
    }

    const ext = getExtensionFromUrl(data.filename);
    const mediaId = generateId();
    const contentType = getMimeTypeFromExtension(ext);

    const result = await getSignedUploadUrl(
      STORAGE_BUCKETS.TALENT,
      `${context.teamId}/temp/${mediaId}.${ext}`,
      contentType
    );

    return { ...result, mediaId };
  });

export const finalizeTalentUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        talentId: ulidSchema,
        type: mediaTypeSchema,
        mediaId: ulidSchema,
        publicUrl: mediaUrlSchema,
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!isTeamTalentStoredUrl(data.publicUrl, context.teamId)) {
      throw new Error('Invalid storage path');
    }

    const talentRecord = await context.scopedDb.talent.getById(data.talentId);
    if (!talentRecord || !isTeamWritableTalent(talentRecord, context.teamId)) {
      throw new Error(
        'Talent not found or you do not have permission to modify it'
      );
    }

    // A still must be cleared or signed before it is stored under the talent;
    // a clip or a recording has no likeness check.
    if (data.type === 'image') {
      await requireUploadRights(context.scopedDb, [data.publicUrl]);
    }

    const tempPath = getPathFromUrl(data.publicUrl, STORAGE_BUCKETS.TALENT);
    const path = `${context.teamId}/${data.talentId}/${data.mediaId}.${getExtensionFromUrl(data.publicUrl)}`;
    await moveFile(STORAGE_BUCKETS.TALENT, tempPath, path);
    const storedUrl = getPublicUrl(STORAGE_BUCKETS.TALENT, path);
    if (data.type === 'image') {
      await carryUploadRights(context.scopedDb, data.publicUrl, storedUrl);
    }

    await context.scopedDb.talent.media.create({
      id: data.mediaId,
      talentId: data.talentId,
      type: data.type,
      url: storedUrl,
      path: `talent/${path}`,
    });

    if (data.type === 'image') {
      await maybePromoteOrGenerateSheet({
        scopedDb: context.scopedDb,
        userId: context.user.id,
        teamId: context.teamId,
        talentId: data.talentId,
        imageUrl: storedUrl,
      });
    }

    return { success: true };
  });

// Generate Talent Sheet

const generateSheetInputSchema = z.object({
  talentId: ulidSchema,
  sheetName: z.string().optional(),
});

export const generateTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(generateSheetInputSchema))
  .handler(async ({ context, data }) => {
    const talentRecord = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );

    if (!talentRecord) {
      throw new Error('Talent not found');
    }

    if (!isTeamWritableTalent(talentRecord, context.teamId)) {
      throw new Error(
        'Talent not found or you do not have permission to modify it'
      );
    }

    const imageMedia = talentRecord.media.filter((m) => m.type === 'image');

    const workflowInput: LibraryTalentSheetWorkflowInput = {
      userId: context.user.id,
      teamId: context.teamId,
      talentId: talentRecord.id,
      talentName: talentRecord.name,
      talentDescription: talentRecord.description ?? undefined,
      referenceImageUrls: imageMedia.map((m) => m.url).sort(),
      sheetName: data.sheetName,
    };
    workflowInput.snapshotInputHash =
      await computeLibraryTalentSheetHashFromDto(workflowInput);

    const runId = await enqueueLibraryTalentSheet({
      talentId: talentRecord.id,
      workflowInput,
      activity: 'sheet',
    });
    return { runId };
  });

export const analyzeTalentMediaFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        imageUrls: z.array(mediaUrlSchema).min(1).max(8),
        filenames: z.array(z.string().max(255)).max(8).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    for (const url of data.imageUrls) {
      if (!isTeamTalentStoredUrl(url, context.teamId)) {
        throw new Error('Image URL is not a talent upload for this team');
      }
    }

    const result = await analyzeTalentMediaForTeam({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      imageUrls: data.imageUrls,
      filenames: data.filenames,
      idempotencyKey: `talent-vision:${data.imageUrls.join('|')}:${(data.filenames ?? []).join('|')}`,
    });
    // The same look is the likeness check (#1581): its verdict goes on the
    // ledger so create never has to run vision a second time.
    const request = getRequest();
    await recordLikenessFinding(
      context.scopedDb,
      data.imageUrls,
      result.subjectKind,
      {
        ipAddress: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      }
    );
    return {
      isCharacterSheet: result.isCharacterSheet,
      subjectKind: result.subjectKind,
      suggestedName: result.suggestedName,
      description: result.description,
      age: result.age,
      gender: result.gender,
      ethnicity: result.ethnicity,
      physicalDescription: result.physicalDescription,
      standardClothing: result.standardClothing,
      distinguishingFeatures: result.distinguishingFeatures,
    };
  });

export const addCharacterToLibraryFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character) {
      throw new Error('Character not found');
    }

    // Verify the character's sequence belongs to this team
    await context.scopedDb.sequences.getForUser({
      sequenceId: character.sequenceId,
    });

    const newTalent = await context.scopedDb.talent.create({
      name: character.name,
      description: character.physicalDescription ?? undefined,
      personality: character.personality ?? undefined,
      movement: character.movement ?? undefined,
      imageUrl: character.sheetImageUrl ?? undefined,
      imagePath: character.sheetImagePath ?? undefined,
      isFavorite: false,
      isHuman: false,
      isInTeamLibrary: true,
    });

    if (character.sheetImageUrl) {
      await context.scopedDb.talent.sheets.create({
        talentId: newTalent.id,
        name: 'Default',
        imageUrl: character.sheetImageUrl,
        imagePath: character.sheetImagePath ?? undefined,
        metadata: characterToBible(character),
        isDefault: true,
        source: 'script_analysis',
      });
    }

    return newTalent;
  });
