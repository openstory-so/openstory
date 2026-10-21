import { listFilesPage } from '#storage';
import { TEAM_USER_UPLOAD_PREFIX } from '@/cast/server/team-user-upload';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { decodeCursor, encodeCursor } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';

/** Composer uploads land where the talent presign writes (#1634). */
export async function listStudioUploadReads(teamId: string, input: PageInput) {
  const scope = [teamId, 'studio-uploads'];
  const cursor = decodeCursor(input.cursor, scope);
  const page = await listFilesPage(
    STORAGE_BUCKETS.TALENT,
    `${teamId}/${TEAM_USER_UPLOAD_PREFIX}`,
    { limit: input.limit, cursor: cursor ?? undefined }
  );
  return {
    uploads: page.files.filter((file) =>
      /^(image|video|audio)\//.test(file.contentType)
    ),
    examined: page.files.length,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor, scope) : null,
  };
}
