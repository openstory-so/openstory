import { listFilesPage } from '#storage';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { decodeCursor, encodeCursor } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';

export async function listStudioUploadReads(teamId: string, input: PageInput) {
  const scope = [teamId, 'studio-uploads'];
  const cursor = decodeCursor(input.cursor, scope);
  const page = await listFilesPage(STORAGE_BUCKETS.TALENT, `${teamId}/temp`, {
    limit: input.limit,
    cursor: cursor ?? undefined,
  });
  return {
    uploads: page.files.filter((file) =>
      /^(image|video|audio)\//.test(file.contentType)
    ),
    examined: page.files.length,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor, scope) : null,
  };
}
