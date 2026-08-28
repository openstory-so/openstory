/**
 * Shared core for creating a library talent: inserts the row, promotes any
 * reference images temp→permanent, and triggers the `/library-talent-sheet`
 * workflow (which writes `talent.defaultSheet`). Used by `createTalentFn` (the
 * dashboard serverFn) and the public API's one-shot resolver, so on-the-fly
 * talent created via the API gets a sheet generated — and the storyboard
 * workflow's `waitForTalentSheets` gate waits for it before casting.
 */

import { moveFile } from '#storage';
import {
  recordPortraitAttestation,
  requireUploadAttestation,
  type LikenessRequestContext,
  type UploadAttestationInput,
} from '@/lib/compliance/likeness-upload';
import { generateId } from '@/lib/db/id';
import type { Talent } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import {
  STORAGE_BUCKETS,
  getPathFromUrl,
  getPublicUrl,
} from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/utils/file';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import {
  analyzeTalentMediaForTeam,
  sheetMetadataFromAnalysis,
} from './analyze-talent-media';
import {
  enqueueLibraryTalentSheet,
  type EnqueueLibraryTalentSheetParams,
} from './enqueue-library-talent-sheet';
import { libraryTalentGenerateDedupId } from './library-talent-sheet-dedup';

const logger = getLogger(['openstory', 'talent', 'create-library-talent']);

export type CreateLibraryTalentInput = {
  name: string;
  description?: string;
  // Nullable to accept the drizzle-zod `createTalentSchema` shape directly.
  isFavorite?: boolean | null;
  isHuman?: boolean | null;
  /** Temp-upload URLs in the TALENT bucket; moved to permanent here. */
  referenceImageUrls?: string[];
  /**
   * Subset of `referenceImageUrls` already classified as a character sheet.
   * `undefined` means classify server-side; `[]` means none are sheets.
   */
  characterSheetImageUrls?: string[];
  portraitAttestation?: UploadAttestationInput;
  /**
   * When false, insert the talent + media and return `deferredSheet` instead
   * of triggering the billed `/library-talent-sheet` workflow. Used by the
   * public API so a later failure cannot charge for a sheet with no sequence.
   * @default true
   */
  enqueueSheet?: boolean;
};

export type CreateLibraryTalentContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
  request?: LikenessRequestContext;
};

export type CreateLibraryTalentResult = {
  talent: Talent;
  sheetWorkflowRunId: string | null;
  /** Present when `enqueueSheet` was false so the caller can trigger later. */
  deferredSheet?: EnqueueLibraryTalentSheetParams;
};

export async function createLibraryTalent(
  input: CreateLibraryTalentInput,
  ctx: CreateLibraryTalentContext
): Promise<CreateLibraryTalentResult> {
  const tempUrls = input.referenceImageUrls ?? [];
  const depictsRealPerson = input.isHuman === true;
  const attestation = tempUrls.length
    ? requireUploadAttestation({
        depictsRealPerson,
        attestation: input.portraitAttestation,
      })
    : null;

  const newTalent = await ctx.scopedDb.talent.create({
    name: input.name,
    description: input.description,
    isFavorite: input.isFavorite ?? false,
    isHuman: depictsRealPerson,
    isInTeamLibrary: true,
  });

  if (attestation) {
    // Recorded before media so a failed insert cannot leave likeness bytes
    // without a warranty. The talent row exists either way.
    await recordPortraitAttestation({
      scopedDb: ctx.scopedDb,
      subjectId: newTalent.id,
      attestation,
      request: ctx.request,
      depictsRealPerson,
    });
  }

  // Move temp files to permanent location and create media records.
  const permanentUrls: string[] = [];
  const tempToPermanent = new Map<string, string>();

  for (const tempUrl of tempUrls) {
    const tempPath = getPathFromUrl(tempUrl, STORAGE_BUCKETS.TALENT);
    const ext = getExtensionFromUrl(tempUrl);
    const mediaId = generateId();
    const permanentPath = `${ctx.teamId}/${newTalent.id}/${mediaId}.${ext}`;

    await moveFile(STORAGE_BUCKETS.TALENT, tempPath, permanentPath);

    const permanentUrl = getPublicUrl(STORAGE_BUCKETS.TALENT, permanentPath);
    permanentUrls.push(permanentUrl);
    tempToPermanent.set(tempUrl, permanentUrl);

    await ctx.scopedDb.talent.media.create({
      talentId: newTalent.id,
      type: 'image',
      url: permanentUrl,
      path: permanentPath,
    });
  }

  let uploadedSheetUrl: string | undefined;
  let uploadedSheetMetadata: CharacterBibleEntry | undefined;

  if (permanentUrls.length > 0) {
    const classifiedTempUrls = input.characterSheetImageUrls;
    if (classifiedTempUrls) {
      uploadedSheetUrl = classifiedTempUrls
        .map((url) => tempToPermanent.get(url))
        .find((url): url is string => Boolean(url));
    } else if (input.enqueueSheet !== false) {
      // One call for every reference: N sequential vision round-trips hung
      // the public-API request (~9s each) and billed before the sequence
      // existed (#1372). A single multi-image analysis already accepts
      // `imageUrls: string[]`. If several images are a sheet we generate
      // rather than pick the wrong URL to promote.
      try {
        const analysis = await analyzeTalentMediaForTeam({
          scopedDb: ctx.scopedDb,
          userId: ctx.user.id,
          imageUrls: permanentUrls,
          idempotencyKey: `talent-vision:create:${newTalent.id}`,
        });
        const [onlyUrl] = permanentUrls;
        if (
          analysis.isCharacterSheet &&
          onlyUrl &&
          permanentUrls.length === 1
        ) {
          uploadedSheetUrl = onlyUrl;
          uploadedSheetMetadata = sheetMetadataFromAnalysis(
            newTalent.name,
            analysis
          );
        }
      } catch (error) {
        logger.warn('Talent-sheet classification failed; treating as photo', {
          err: error,
          talentId: newTalent.id,
        });
      }
    }

    if (
      uploadedSheetUrl &&
      !uploadedSheetMetadata &&
      input.enqueueSheet !== false
    ) {
      try {
        const analysis = await analyzeTalentMediaForTeam({
          scopedDb: ctx.scopedDb,
          userId: ctx.user.id,
          imageUrls: [uploadedSheetUrl],
          idempotencyKey: `talent-vision:create-meta:${newTalent.id}:${uploadedSheetUrl}`,
        });
        uploadedSheetMetadata = sheetMetadataFromAnalysis(
          newTalent.name,
          analysis
        );
      } catch (error) {
        logger.warn('Uploaded sheet metadata extraction failed', {
          err: error,
          talentId: newTalent.id,
        });
      }
    }
  }

  // Sheet payload: if the user uploaded a sheet we store that image;
  // otherwise we generate a 4-panel (from reference photos and/or the
  // name + description). The public API defers the billed trigger until
  // the sequence exists (`enqueueSheet: false`).
  const workflowInput: LibraryTalentSheetWorkflowInput = {
    userId: ctx.user.id,
    teamId: ctx.teamId,
    talentId: newTalent.id,
    talentName: newTalent.name,
    talentDescription: newTalent.description ?? undefined,
    referenceImageUrls: [...permanentUrls].sort(),
    sheetName: uploadedSheetUrl ? 'Uploaded Sheet' : 'Default Sheet',
    uploadedSheetUrl,
    uploadedSheetMetadata,
  };
  workflowInput.snapshotInputHash =
    await computeLibraryTalentSheetHashFromDto(workflowInput);

  const deferredSheet: EnqueueLibraryTalentSheetParams = {
    talentId: newTalent.id,
    workflowInput,
    activity: uploadedSheetUrl ? 'portrait' : 'sheet',
    deduplicationId: libraryTalentGenerateDedupId(newTalent.id),
  };

  if (input.enqueueSheet === false) {
    return { talent: newTalent, sheetWorkflowRunId: null, deferredSheet };
  }

  let sheetWorkflowRunId: string | null = null;
  try {
    // Shared with generate-if-missing on later photo drops so parallel
    // finalizes reuse this run instead of billing another 4-panel.
    sheetWorkflowRunId = await enqueueLibraryTalentSheet(deferredSheet);
  } catch {
    // Talent row + media already exist; enqueue already emitted `failed`.
    // Return them so the dialog can say "added" without claiming a run started.
  }

  return { talent: newTalent, sheetWorkflowRunId };
}
