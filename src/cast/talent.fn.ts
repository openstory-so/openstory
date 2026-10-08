import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { deleteFile, getSignedUploadUrl } from '#storage';
import { requireTeamAdminAccess } from '@/platform/server/auth/action-utils';
import { generateId } from '@/platform/id';
import {
  getPublicTalentWithRelations,
  listPublicTalent,
} from '@/platform/server/db/scoped';
import type { TalentWithSheets } from '@/platform/server/db/schema';
import {
  recordLikenessFinding,
  requireUploadRights,
} from '@/cast/server/upload-rights';
import {
  assertTeamUserUploadAttachable,
  teamUserUploadStoragePath,
} from '@/cast/server/team-user-upload';
import { getRequest } from '@tanstack/react-start/server';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  createTalentSchema,
  listTalentFilterSchema,
  updateTalentSchema,
} from '@/cast/server/talent.schemas';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import type { LibraryTalentSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import type { SheetPayload } from '@/cast/server/workflows/sheet-snapshots';
import { releaseVoiceIfUnreferenced } from '@/cast/server/voice/release-voice';
import { isTeamWritableTalent } from '@/cast/server/db/talent';
import { analyzeTalentMediaForTeam } from '@/cast/server/talent/analyze-talent-media';
import { createLibraryTalent } from '@/cast/server/talent/create-library-talent';
import { enqueueLibraryTalentSheet } from '@/cast/server/talent/enqueue-library-talent-sheet';
import { saveCharacterFaceAsTalent } from '@/cast/server/talent/save-character-face';
import { maybePromoteOrGenerateSheet } from '@/cast/server/talent/promote-or-generate-sheet';
import { isTeamTalentStoredUrl } from '@/platform/server/storage/copy-stored-image';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';

const talentIdSchema = z.object({ talentId: ulidSchema });
const sheetIdSchema = z.object({ talentId: ulidSchema, sheetId: ulidSchema });
const mediaIdSchema = z.object({ mediaId: ulidSchema });

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

// Delete Talent (requires admin/owner role). Refused while a character
// version casts it (#2018) — `talent.delete` throws the reason.

export const deleteTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    await requireTeamAdminAccess(context.user.id, context.teamId);

    const existing = await context.scopedDb.talent.getById(data.talentId);
    if (!existing || !isTeamWritableTalent(existing, context.teamId)) {
      throw new Error(
        'Talent not found, is read-only, or you do not have permission to delete it'
      );
    }
    // Slot first, row second (#1553): a failed provider delete keeps the
    // pointer on this row, so the next attempt can release it. This row is
    // the one reference the count must ignore. (Only a recorded Seed voice
    // lives here since #2018, which holds no slot; kept for #1631.)
    if (existing.voiceId) {
      await releaseVoiceIfUnreferenced(context.scopedDb, existing.voiceId, {
        heldBy: 1,
      });
    }
    if (!(await context.scopedDb.talent.delete(data.talentId))) {
      throw new Error('Talent not found');
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

// The reference sheet (#2018): pick one from the history, discard, restore.

export const selectTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) =>
    context.scopedDb.talent.selectSheet(data.talentId, data.sheetId)
  );

export const discardTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => ({
    discardedAt: await context.scopedDb.talent.sheets.discard(data.sheetId),
  }));

export const undiscardTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => {
    await context.scopedDb.talent.sheets.undiscard(data.sheetId);
    return { success: true };
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
 * Every talent upload lands in `uploads/` and stays there (#1634). Finalize
 * checks the likeness ledger then points the media row at that key — same
 * contract as elements (#1471). Generated sheets/headshots still live under
 * the talent id.
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
      teamUserUploadStoragePath(context.teamId, mediaId, ext),
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
    const talentRecord = await context.scopedDb.talent.getById(data.talentId);
    if (!talentRecord || !isTeamWritableTalent(talentRecord, context.teamId)) {
      throw new Error(
        'Talent not found or you do not have permission to modify it'
      );
    }

    const { path, url } = await assertTeamUserUploadAttachable({
      url: data.publicUrl,
      bucket: STORAGE_BUCKETS.TALENT,
      teamId: context.teamId,
    });

    // A still must be cleared or signed before the row points at it; a clip
    // or a recording has no likeness check.
    if (data.type === 'image') {
      await requireUploadRights(context.scopedDb, [url]);
    }

    await context.scopedDb.talent.media.create({
      id: data.mediaId,
      talentId: data.talentId,
      type: data.type,
      url,
      path,
    });

    if (data.type === 'image') {
      await maybePromoteOrGenerateSheet({
        scopedDb: context.scopedDb,
        userId: context.user.id,
        teamId: context.teamId,
        talentId: data.talentId,
        imageUrl: url,
      });
    }

    return { success: true };
  });

// Generate Talent Sheet

export const generateTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(talentIdSchema))
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

    const workflowInputFields: SheetPayload<LibraryTalentSheetWorkflowInput> = {
      userId: context.user.id,
      teamId: context.teamId,
      talentId: talentRecord.id,
      talentName: talentRecord.name,
      talentDescription: talentRecord.description ?? undefined,
      referenceImageUrls: imageMedia.map((m) => m.url).sort(),
    };
    const workflowInput = {
      ...workflowInputFields,
      snapshotInputHash:
        await computeLibraryTalentSheetHashFromDto(workflowInputFields),
    };

    const runId = await enqueueLibraryTalentSheet(context.scopedDb, {
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

/** Save a character's face as a new talent (#2018): see `save-character-face.ts`. */
export const saveCharacterAsTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(z.object({ sequenceId: ulidSchema, characterId: ulidSchema }))
  )
  .handler(async ({ context, data }) =>
    saveCharacterFaceAsTalent(
      context.scopedDb,
      { userId: context.user.id, teamId: context.teamId },
      data
    )
  );
