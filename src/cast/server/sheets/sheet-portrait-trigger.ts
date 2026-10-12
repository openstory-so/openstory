import { getLogger } from '@/platform/logger';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { SheetPortraitWorkflowInput } from '@/platform/server/workflow/types';

const logger = getLogger(['openstory', 'cast', 'sheet-portrait']);

/**
 * Start the portrait run of a sheet version that was just saved. Every sheet
 * is saved and shown first, a generated one and an uploaded one alike; the
 * tile crops it until the portrait lands. One run per sheet version.
 *
 * Never throws: the sheet has already landed, and a trigger that fails (or
 * is refused for a restricted account) leaves the crop and is logged.
 *
 * Mid-run callers pass `enforcement` rows from
 * `scopedDb.liveRead.compliance.listEnforcementFor`; a request-path caller
 * omits it and the trigger loads them.
 */
export async function triggerSheetPortrait(
  input: SheetPortraitWorkflowInput,
  enforcement?: NonNullable<
    Parameters<typeof triggerWorkflow>[2]
  >['enforcement']
): Promise<void> {
  try {
    await triggerWorkflow('/sheet-portrait', input, {
      deduplicationId: `sheet-portrait-${input.versionId}`,
      enforcement,
    });
  } catch (error) {
    logger.error('sheet portrait run not started', { err: error });
  }
}
