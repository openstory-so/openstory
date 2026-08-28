/**
 * After an image lands on an existing talent: promote it as a sheet if
 * vision says it already is one, otherwise generate a 4-panel only when
 * the talent has no convergent sheet yet.
 */

import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { isTeamWritableTalent } from '@/lib/db/scoped/talent';
import { getLogger } from '@/lib/observability/logger';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import {
  analyzeTalentMediaForTeam,
  sheetMetadataFromAnalysis,
} from './analyze-talent-media';
import { enqueueLibraryTalentSheet } from './enqueue-library-talent-sheet';
import {
  libraryTalentGenerateDedupId,
  libraryTalentUploadDedupId,
} from './library-talent-sheet-dedup';

const logger = getLogger(['openstory', 'talent', 'promote-or-generate-sheet']);

export type PromoteOrGenerateSheetInput = {
  scopedDb: ScopedDb;
  userId: string;
  teamId: string;
  talentId: string;
  /** Origin-relative `/r2/talent/<teamId>/…` URL derived from the verified path. */
  imageUrl: string;
};

export async function maybePromoteOrGenerateSheet(
  params: PromoteOrGenerateSheetInput
): Promise<void> {
  const talentRecord = await params.scopedDb.talent.getWithRelations(
    params.talentId
  );
  if (!talentRecord || !isTeamWritableTalent(talentRecord, params.teamId)) {
    return;
  }

  const imageMedia = talentRecord.media.filter((m) => m.type === 'image');
  const convergentSheets = talentRecord.sheets.filter((s) => !s.divergedAt);

  let uploadedSheetUrl: string | undefined;
  let uploadedSheetMetadata: CharacterBibleEntry | undefined;
  try {
    const analysis = await analyzeTalentMediaForTeam({
      scopedDb: params.scopedDb,
      userId: params.userId,
      imageUrls: [params.imageUrl],
      idempotencyKey: `talent-vision:finalize:${params.talentId}:${params.imageUrl}`,
    });
    if (analysis.isCharacterSheet) {
      uploadedSheetUrl = params.imageUrl;
      uploadedSheetMetadata = sheetMetadataFromAnalysis(
        talentRecord.name,
        analysis
      );
    }
  } catch (error) {
    logger.warn('Talent-sheet classification failed; treating as photo', {
      err: error,
      talentId: params.talentId,
    });
  }

  if (!uploadedSheetUrl && convergentSheets.length > 0) {
    return;
  }

  const workflowInput: LibraryTalentSheetWorkflowInput = {
    userId: params.userId,
    teamId: params.teamId,
    talentId: talentRecord.id,
    talentName: talentRecord.name,
    talentDescription: talentRecord.description ?? undefined,
    referenceImageUrls: imageMedia.map((m) => m.url).sort(),
    sheetName: uploadedSheetUrl ? 'Uploaded Sheet' : 'Default Sheet',
    uploadedSheetUrl,
    uploadedSheetMetadata,
  };
  workflowInput.snapshotInputHash =
    await computeLibraryTalentSheetHashFromDto(workflowInput);

  await enqueueLibraryTalentSheet({
    talentId: talentRecord.id,
    workflowInput,
    activity: uploadedSheetUrl ? 'portrait' : 'sheet',
    deduplicationId: uploadedSheetUrl
      ? libraryTalentUploadDedupId(talentRecord.id, uploadedSheetUrl)
      : libraryTalentGenerateDedupId(talentRecord.id),
  });
}
