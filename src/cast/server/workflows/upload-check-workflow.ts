/**
 * The likeness check for one upload, as a run (#2192). Started by the
 * upload route when the bytes land, so nothing the tab does can cut it off.
 * Writes the classifier's verdict to the ledger; see `upload-check.ts`.
 */

import type { UploadCheckWorkflowInput } from '@/cast/server/upload-check';
import {
  classifyUpload,
  type LikenessCheckDb,
} from '@/cast/server/upload-rights';
import type { UploadRights } from '@/cast/upload-rights';
import { OpenStoryError } from '@/platform/errors';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

/** The check's reads and writes, through the run's named hatches. */
function likenessCheckDb(scopedDb: WorkflowScopedDb): LikenessCheckDb {
  return {
    teamId: scopedDb.teamId,
    userId: scopedDb.userId,
    apiKeys: {
      resolveLlmKey: (model) => scopedDb.credentials.resolveLlmKey(model),
    },
    billing: {
      hasEnoughCredits: (amount) =>
        scopedDb.liveRead.billing.hasEnoughCredits(amount),
      deductCredits: (...args) => scopedDb.billing.deductCredits(...args),
    },
    compliance: {
      attestations: {
        listForSubject: (...args) =>
          scopedDb.liveRead.compliance.attestations.listForSubject(...args),
        record: (...args) => scopedDb.compliance.attestations.record(...args),
      },
    },
  };
}

type CheckOutcome =
  | { ok: true; rights: UploadRights }
  | { ok: false; code: string; message: string };

export class UploadCheckWorkflow extends OpenStoryWorkflowEntrypoint<UploadCheckWorkflowInput> {
  protected override readonly failureLabel = 'Upload check';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<UploadCheckWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<UploadRights> {
    const { userId, url, filename, ipAddress, userAgent } = event.payload;
    const outcome = await step.do(
      'classify',
      { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } },
      async (): Promise<CheckOutcome> => {
        try {
          const rights = await classifyUpload({
            scopedDb: likenessCheckDb(scopedDb),
            userId,
            url,
            filename: filename ?? undefined,
            request: { ipAddress, userAgent },
          });
          return { ok: true, rights };
        } catch (error) {
          // A refusal (no credits, a file the check cannot read) is the
          // same on a retry. Its code is how the reader tells them apart.
          if (error instanceof OpenStoryError) {
            return { ok: false, code: error.code, message: error.message };
          }
          throw error;
        }
      }
    );
    if (!outcome.ok) throw new NonRetryableError(outcome.message, outcome.code);
    return outcome.rights;
  }
}
