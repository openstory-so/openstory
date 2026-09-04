/**
 * Which native media vias this team would actually reach.
 *
 * A via is claimed per TEAM at submit time — `submitMotionJob` resolves an xAI
 * key (team `xai` key → platform `XAI_API_KEY` → neither) and then claims
 * BytePlus for native models unless the team is on its own fal key. Everything
 * the client wants to say about a model's route therefore depends on state the
 * client cannot see: a platform env var and a team's BYOK rows.
 *
 * Both answers reuse the SAME functions the submit path uses
 * (`resolveOptionalKey`, `claimBytePlusVia`), so the UI's claim and the job's
 * route cannot drift into disagreeing.
 *
 * Advisory only. The server re-decides at submit time from live keys, because a
 * key can be revoked between the page load and the click — treat this as "what
 * to show", never "what will happen".
 */

import { createServerFn } from '@tanstack/react-start';
import { claimBytePlusVia } from '@/lib/ai/byteplus-config';
import {
  referenceOnlyMotionModels,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { authWithTeamMiddleware } from './middleware';

export type ViaAvailability = {
  /**
   * Native xAI (Grok) reachable — a team `xai` key or the platform
   * `XAI_API_KEY`. Grok's fal id is an image-to-video endpoint, so this is
   * exactly the condition under which Grok can render reference-only shots.
   */
  xai: boolean;
  /**
   * BytePlus Ark reachable for a NATIVE model (Seedance / Seedream). False for
   * a team on its own fal key: BYOK fal stays on fal, their key, their bill.
   */
  byteplus: boolean;
  /**
   * Video models that can render reference-only shots for THIS team, resolved
   * here rather than on the client so the two cannot disagree — derived from
   * the flags above by `referenceOnlyMotionModels`, the same function the
   * submit-path guard uses.
   */
  referenceOnlyModels: ImageToVideoModel[];
};

export const getViaAvailabilityFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }): Promise<ViaAvailability> => {
    const [xaiKey, falKey] = await Promise.all([
      context.scopedDb.apiKeys.resolveOptionalKey('xai'),
      context.scopedDb.apiKeys.resolveOptionalKey('fal'),
    ]);
    const vias = {
      xai: Boolean(xaiKey),
      byteplus:
        claimBytePlusVia({
          native: true,
          usingOwnFalKey: falKey?.source === 'team',
        }) === 'byteplus',
    };
    return { ...vias, referenceOnlyModels: referenceOnlyMotionModels(vias) };
  });
