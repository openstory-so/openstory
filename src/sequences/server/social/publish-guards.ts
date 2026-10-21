/**
 * Pre-send guards for `publishSequenceExportFn` (#1267). Anything they throw
 * happens before Upload-Post is called, so the server fn reports it as
 * `not_sent`.
 */

import type { SequenceExport } from '@/platform/server/db/schema';
import { isLoopbackOrBareIp } from '@/platform/server/env/environment';

/**
 * The export must belong to the sequence the middleware just authorised —
 * `getById` alone would let a caller publish another team's file — and be a
 * finished render.
 */
export function assertPublishableExport<
  T extends Pick<SequenceExport, 'sequenceId' | 'status'>,
>(exportRow: T | null, sequenceId: string): asserts exportRow is T {
  if (!exportRow || exportRow.sequenceId !== sequenceId) {
    throw new Error('Export not found for this sequence');
  }
  if (exportRow.status !== 'ready') {
    throw new Error(`Export is ${exportRow.status}, not ready to publish`);
  }
}

/** Upload-Post fetches the MP4 from its side, so it must be public https. */
export function assertPublicVideoUrl(videoUrl: string): void {
  const hostname = new URL(videoUrl).hostname.replace(/^\[|\]$/g, '');
  if (
    !videoUrl.startsWith('https://') ||
    isLoopbackOrBareIp(hostname) ||
    hostname.endsWith('.localhost')
  ) {
    throw new Error(
      'This render is not reachable from the internet, so Upload-Post cannot fetch it. Publishing works on a deployed OpenStory.'
    );
  }
}
