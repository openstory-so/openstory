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
import {
  AttestationRequiredError,
  OpenStoryError,
  ValidationError,
} from '@/platform/errors';
import {
  getPublicUrl,
  LIKENESS_CHECKED_BUCKETS,
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import {
  assertCanGenerate,
  resolveEnforcementState,
} from '@/platform/server/compliance/enforcement';
import { loadComplianceRecords } from '@/platform/server/db/scoped';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { buildInstanceId } from '@/platform/server/workflow/instance-id';
import { readInstanceIfExists } from '@/platform/server/workflow/run-outcome';
import type { UserWorkflowContext } from '@/platform/server/workflow/types';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { UploadCheck, UploadRef } from '@/cast/upload-rights';
import {
  classifyUpload,
  isCheckable,
  requireCheckable,
  requireUploadRights,
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

type StoredUpload = {
  bucket: StorageBucket;
  contentType: string;
  teamId: string;
  userId: string;
};

/**
 * Refuse, before any bytes are written, an upload whose check could not
 * start: the trigger refuses an account that may not generate, and an
 * upload refused after it landed would leave its bytes behind.
 */
export async function requireUploadCheckAllowed(
  opts: StoredUpload
): Promise<void> {
  if (!checksOnUpload(opts.bucket, opts.contentType)) return;
  const { enforcement } = await loadComplianceRecords(opts.userId, opts.teamId);
  assertCanGenerate(resolveEnforcementState(enforcement));
}

/**
 * Start the check for an upload the route just stored, when the gate judges
 * that kind of file. Called after the bytes land, so the check never waits
 * on the browser.
 */
export async function startCheckForStoredUpload(
  opts: StoredUpload & { path: string; request: Request }
): Promise<void> {
  if (!checksOnUpload(opts.bucket, opts.contentType)) return;
  await startUploadCheck({
    userId: opts.userId,
    teamId: opts.teamId,
    url: getPublicUrl(opts.bucket, opts.path),
    // A hint only, as the browser's filename always was; capped like
    // `uploadRefSchema`.
    filename:
      new URL(opts.request.url).searchParams.get('filename')?.slice(0, 255) ??
      null,
    ipAddress: opts.request.headers.get('cf-connecting-ip'),
    userAgent: opts.request.headers.get('user-agent'),
  });
}

type CheckRun = {
  attempt: number;
  status: string;
  /** The engine's error, flattened to `NAME: message`. */
  error: string | null;
};

/** The newest attempt's run for this URL, or null when none was started. */
async function latestCheckRun(
  teamId: string,
  url: string
): Promise<CheckRun | null> {
  const suffix = await checkKey(teamId, url);
  let latest: CheckRun | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const read = await readInstanceIfExists(
      buildInstanceId({
        env: getEnv(),
        workflowName: UPLOAD_CHECK_TRIGGER,
        suffix,
        generation: attempt,
      })
    );
    if (read.kind === 'missing') break;
    if (read.kind !== 'read') {
      throw new OpenStoryError(
        'The check for a real person could not be read. Try again.',
        'UPLOAD_CHECK_FAILED',
        502
      );
    }
    latest = { attempt, status: read.status, error: read.error };
  }
  return latest;
}

/**
 * A failed run as the error the user sees. A refusal (no credits, a file
 * the check cannot read) ends the run under its error code, so the client
 * can still offer what fixes it.
 */
function checkFailure(run: CheckRun): OpenStoryError {
  const [, code, message] =
    /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(run.error ?? '') ?? [];
  return code && message
    ? new OpenStoryError(message, code, 400)
    : new OpenStoryError(
        'The check for a real person stopped. Try again.',
        'UPLOAD_CHECK_FAILED',
        502
      );
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
  if (run && isRunning(run)) {
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

/** A run the engine is still working on (not finished, failed or stopped). */
function isRunning(run: CheckRun): boolean {
  return !['complete', 'errored', 'terminated'].includes(run.status);
}

/**
 * {@link requireUploadRights}, but an upload with no row is checked here
 * first instead of refused (#2192). For a request that takes URLs the
 * caller may never have checked: a past upload, a raw URL, an upload behind
 * a reused clip. An upload whose run is still going is refused as still
 * checking, so the vision call never runs (and bills) twice. Another team's
 * file is never checked; with no row it is refused. A failed check throws;
 * a real person still needs the sign-off.
 */
export async function requireCheckedUploadRights(
  scopedDb: ScopedDb,
  urls: string[],
  request: LikenessRequestContext
): Promise<Map<string, { depictsRealPerson: boolean }>> {
  for (const url of new Set(urls)) {
    if (!isCheckable(url, scopedDb.teamId)) continue;
    if (await uploadRightsOnRecord(scopedDb, url)) continue;
    const run = await latestCheckRun(scopedDb.teamId, url);
    if (run && isRunning(run)) {
      throw new AttestationRequiredError(
        'This upload is still being checked for a real person. Try again in a moment.'
      );
    }
    await classifyUpload({ scopedDb, userId: scopedDb.userId, url, request });
  }
  return requireUploadRights(scopedDb, urls);
}
