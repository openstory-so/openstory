/**
 * Upload check runs (#2192): the likeness check as a durable workflow.
 *
 * The upload route starts it when the bytes land, so a closed tab, a reload
 * or a trip to checkout cannot cut it off. The browser only reads the
 * result: the ledger row once there is one, else the run's state. One run
 * per team and URL (the dedup id is their hash); a retry after a failed run is a
 * new attempt, up to the trigger's generation cap.
 */

import { getEnv } from '#env';
import { sha256Hex } from '@/platform/compliance/hash';
import { OpenStoryError, ValidationError } from '@/platform/errors';
import {
  getPublicUrl,
  LIKENESS_CHECKED_BUCKETS,
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { isInstanceNotFoundError } from '@/platform/server/workflow/errors';
import { buildInstanceId } from '@/platform/server/workflow/instance-id';
import { disposeRpcStub } from '@/platform/server/workflow/rpc-dispose';
import { getCfBindingForTriggerPath } from '@/platform/server/workflow/trigger-bindings';
import type {
  CloudflareEnv,
  UserWorkflowContext,
} from '@/platform/server/workflow/types';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { UploadCheck, UploadRef } from '@/cast/upload-rights';
import {
  requireCheckable,
  uploadRightsOnRecord,
  type LikenessRequestContext,
} from './upload-rights';

const UPLOAD_CHECK_TRIGGER = 'upload-check';

/** Matches `MAX_TRIGGER_GENERATIONS`: the original run plus two retries. */
const MAX_ATTEMPTS = 3;

export type UploadCheckWorkflowInput = UserWorkflowContext & {
  url: string;
  /** The original filename, a hint for the classifier; null when unknown. */
  filename: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * Uploads the gate judges, by where they are stored: every still a user
 * brings in, and a clip only where it can become a reference (an element,
 * a Studio reference, #1930). A shot's own clip and audio are not checked.
 */
function checksOnUpload(bucket: StorageBucket, contentType: string): boolean {
  if (contentType.startsWith('image/')) {
    return LIKENESS_CHECKED_BUCKETS.has(bucket);
  }
  if (contentType.startsWith('video/')) {
    return (
      bucket === STORAGE_BUCKETS.TALENT || bucket === STORAGE_BUCKETS.ELEMENTS
    );
  }
  return false;
}

/** Per team: two teams may check the same raw URL, each on its own run. */
async function checkKey(teamId: string, url: string): Promise<string> {
  return sha256Hex(`${teamId}:${url}`);
}

/** Start (or join) the check for one upload. */
async function startUploadCheck(
  input: UploadCheckWorkflowInput
): Promise<void> {
  await triggerWorkflow(`/${UPLOAD_CHECK_TRIGGER}`, input, {
    deduplicationId: await checkKey(input.teamId, input.url),
  });
}

/**
 * Start the check for an upload the route just stored, when the gate judges
 * that kind of file. Called after the bytes land, so the check never waits
 * on the browser.
 */
export async function startCheckForStoredUpload(opts: {
  bucket: StorageBucket;
  path: string;
  contentType: string;
  teamId: string;
  userId: string;
  request: Request;
}): Promise<void> {
  if (!checksOnUpload(opts.bucket, opts.contentType)) return;
  await startUploadCheck({
    userId: opts.userId,
    teamId: opts.teamId,
    url: getPublicUrl(opts.bucket, opts.path),
    filename: null,
    ipAddress: opts.request.headers.get('cf-connecting-ip'),
    userAgent: opts.request.headers.get('user-agent'),
  });
}

type CheckRun = {
  attempt: number;
  status: InstanceStatus['status'];
  error: { name: string; message: string } | null;
};

/** The newest attempt's run for this URL, or null when none was started. */
async function latestCheckRun(
  teamId: string,
  url: string
): Promise<CheckRun | null> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const env = getEnv() as unknown as CloudflareEnv;
  const binding = getCfBindingForTriggerPath(UPLOAD_CHECK_TRIGGER, env);
  const suffix = await checkKey(teamId, url);
  let latest: CheckRun | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const id = buildInstanceId({
      env,
      workflowName: UPLOAD_CHECK_TRIGGER,
      suffix,
      generation: attempt,
    });
    let instance: WorkflowInstance;
    try {
      instance = await binding.get(id);
    } catch (error) {
      if (isInstanceNotFoundError(error)) break;
      throw error;
    }
    try {
      const { status, error } = await instance.status();
      latest = { attempt, status, error: error ?? null };
    } finally {
      disposeRpcStub(instance);
    }
  }
  return latest;
}

/**
 * A failed run as the error the user sees. A refusal (no credits, a file
 * the check cannot read) ends the run under its error code, so the client
 * can still offer what fixes it.
 */
function checkFailure(run: CheckRun): OpenStoryError {
  const name = run.error?.name ?? '';
  const message = run.error?.message ?? 'The check for a real person stopped.';
  return /^[A-Z][A-Z_]+$/.test(name)
    ? new OpenStoryError(message, name, 400)
    : new OpenStoryError(message, 'UPLOAD_CHECK_FAILED', 502);
}

function checkInput(
  scopedDb: Pick<ScopedDb, 'teamId' | 'userId'>,
  ref: UploadRef,
  request: LikenessRequestContext
): UploadCheckWorkflowInput {
  return {
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
    url: ref.url,
    filename: ref.filename ?? null,
    ipAddress: request.ipAddress ?? null,
    userAgent: request.userAgent ?? null,
  };
}

/**
 * The check's answer for one upload. An upload with no run yet (one made
 * before #2192, or a raw URL) starts one here. A failed run throws; it is
 * not restarted until {@link retryUploadCheck}, so the failure is seen.
 */
export async function readUploadCheck(
  scopedDb: ScopedDb,
  ref: UploadRef,
  request: LikenessRequestContext
): Promise<UploadCheck> {
  requireCheckable(ref.url, scopedDb.teamId);
  const onRecord = await uploadRightsOnRecord(scopedDb, ref.url);
  if (onRecord) return onRecord;
  const run = await latestCheckRun(scopedDb.teamId, ref.url);
  if (!run) {
    await startUploadCheck(checkInput(scopedDb, ref, request));
    return { status: 'checking' };
  }
  switch (run.status) {
    case 'complete': {
      // The verdict is written inside the run, so it is there now.
      const written = await uploadRightsOnRecord(scopedDb, ref.url);
      if (written) return written;
      throw new OpenStoryError(
        'The check for a real person finished without a verdict.',
        'UPLOAD_CHECK_FAILED',
        502
      );
    }
    case 'errored':
    case 'terminated':
      throw checkFailure(run);
    default:
      return { status: 'checking' };
  }
}

/** Start the check again after a failed run. */
export async function retryUploadCheck(
  scopedDb: ScopedDb,
  ref: UploadRef,
  request: LikenessRequestContext
): Promise<UploadCheck> {
  requireCheckable(ref.url, scopedDb.teamId);
  const onRecord = await uploadRightsOnRecord(scopedDb, ref.url);
  if (onRecord) return onRecord;
  const run = await latestCheckRun(scopedDb.teamId, ref.url);
  if (run && run.status !== 'errored' && run.status !== 'terminated') {
    return { status: 'checking' };
  }
  if (run && run.attempt >= MAX_ATTEMPTS) {
    throw new ValidationError(
      `This upload couldn’t be checked after ${MAX_ATTEMPTS} tries. Upload it again.`
    );
  }
  await startUploadCheck(checkInput(scopedDb, ref, request));
  return { status: 'checking' };
}
