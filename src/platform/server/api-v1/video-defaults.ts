/**
 * What a request that names no video model gets, for THIS team.
 *
 * Seedance 2.5 renders (and drafts) only on the BytePlus via, so the default
 * depends on the team's route: asked the same way the picker asks
 * (`getViaAvailabilityFn`), so the API and the app start a new sequence on
 * the same model with the same "Draft first".
 */

import { defaultVideoModelFor, type ImageToVideoModel } from '@/models/models';
import { claimBytePlusVia } from '@/models/server/byteplus-config';
import type { ScopedDb } from '@/platform/server/db/scoped';

export type ApiVideoDefaults = {
  videoModel: ImageToVideoModel;
  /** Whether this team reaches BytePlus — the only route that drafts. */
  byteplus: boolean;
};

export async function resolveApiVideoDefaults(
  scopedDb: ScopedDb
): Promise<ApiVideoDefaults> {
  const falKey = await scopedDb.apiKeys.resolveOptionalKey('fal');
  const byteplus =
    claimBytePlusVia({
      native: true,
      usingOwnFalKey: falKey?.source === 'team',
    }) === 'byteplus';
  return { videoModel: defaultVideoModelFor({ byteplus }), byteplus };
}
