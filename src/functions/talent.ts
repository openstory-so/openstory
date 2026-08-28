import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { deleteFile, getSignedUploadUrl } from '#storage';
import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { generateId } from '@/lib/db/id';
import {
  getPublicTalentWithRelations,
  listPublicTalent,
} from '@/lib/db/scoped';
import type { TalentWithSheets } from '@/lib/db/schema';
import {
  recordPortraitAttestation,
  requireUploadAttestation,
  uploadAttestationSchema,
} from '@/lib/compliance/likeness-upload';
import { getRequest } from '@tanstack/react-start/server';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createTalentSchema,
  createTalentSheetSchema,
  listTalentFilterSchema,
  updateTalentSchema,
} from '@/lib/schemas/talent.schemas';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import { isTeamWritableTalent } from '@/lib/db/scoped/talent';
import { createLibraryTalent } from '@/lib/talent/create-library-talent';
import { analyzeTalentMediaForTeam } from '@/lib/talent/analyze-talent-media';
import { enqueueLibraryTalentSheet } from '@/lib/talent/enqueue-library-talent-sheet';
import { maybePromoteOrGenerateSheet } from '@/lib/talent/promote-or-generate-sheet';
import { isTeamTalentStoredUrl } from '@/lib/storage/copy-stored-image';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

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
    const request = getRequest();
    return createLibraryTalent(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
      request: {
        ipAddress: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      },
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

    const storagePath = data.talentId
      ? `${context.teamId}/${data.talentId}/${mediaId}.${ext}`
      : `${context.teamId}/temp/${mediaId}.${ext}`;

    const result = await getSignedUploadUrl(
      STORAGE_BUCKETS.TALENT,
      storagePath,
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
        path: z.string().min(1),
        portraitAttestation: uploadAttestationSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.path.startsWith(`talent/${context.teamId}/`)) {
      throw new Error('Invalid storage path');
    }

    const talentRecord = await context.scopedDb.talent.getById(data.talentId);
    if (!talentRecord || !isTeamWritableTalent(talentRecord, context.teamId)) {
      throw new Error(
        'Talent not found or you do not have permission to modify it'
      );
    }

    const attestation = requireUploadAttestation({
      depictsRealPerson: talentRecord.isHuman === true,
      attestation: data.portraitAttestation,
    });
    const request = getRequest();
    await recordPortraitAttestation({
      scopedDb: context.scopedDb,
      subjectId: data.talentId,
      attestation,
      request: {
        ipAddress: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      },
      depictsRealPerson: talentRecord.isHuman === true,
    });

    const storedUrl = `/r2/${data.path}`;
    await context.scopedDb.talent.media.create({
      id: data.mediaId,
      talentId: data.talentId,
      type: data.type,
      url: storedUrl,
      path: data.path,
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
        metadata: {
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
        isDefault: true,
        source: 'script_analysis',
      });
    }

    return newTalent;
  });
