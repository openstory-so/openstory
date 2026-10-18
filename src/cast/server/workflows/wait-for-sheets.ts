/**
 * Durable wait for element vision.
 *
 * Elements uploaded while creating a sequence kick off `/element-vision`.
 * Analyze reads their descriptions, so this helper polls until vision is
 * terminal — bounded so a failed vision cannot stall the pipeline.
 *
 * The poll uses `step.do` (durable, replay-safe) for each read and `step.sleep`
 * between reads, mirroring the batched-polling pattern in `motion-workflow.ts`.
 */

import type { SequenceElement } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'wait-for-sheets']);

/**
 * The polling reads these helpers make. Narrowed so callers hand over
 * `scopedDb.liveRead` — polling a sibling workflow's late writes is one of the
 * sanctioned live reads, and this type is what says so at the boundary.
 */
export type WaitForSheetsReadDb = {
  sequenceElements: Pick<ScopedDb['sequenceElements'], 'listByIds'>;
};

/** Read interval between durable poll attempts. */
const POLL_INTERVAL: WorkflowSleepDuration = '5 seconds';

/**
 * Max poll attempts. 36 × 5s ≈ 3 minutes — comfortably longer than a sheet
 * generation (image + headshot/preview, ~30-60s) but short enough that a
 * permanently-failed sheet only delays matching by a bounded amount before it
 * proceeds best-effort.
 */
const MAX_ATTEMPTS = 36;

export type WaitForSheetsResult<TRow> = {
  /** True if every entity became ready before the timeout. */
  ready: boolean;
  /** Ids of entities still missing a sheet when the wait returned. */
  pendingIds: string[];
  /**
   * Rows from the final poll — the freshest read the wait already performed.
   * Callers consume these instead of issuing a second read, which would both
   * cost an extra query and re-open the very window the wait just closed.
   */
  rows: TRow[];
};

/**
 * Optional hook fired exactly once, the first time a wait is actually needed
 * (i.e. the first poll finds pending entities). Use it to surface "waiting for
 * sheets…" UI feedback. It runs inside its own durable step, so it emits once
 * per run even across replays. Skipped entirely when everything is already
 * ready, so it never produces a spurious "waiting" flash.
 */
type OnWaitNeeded = (pendingCount: number) => Promise<void> | void;

type PollArgs<TRow> = {
  ids: string[];
  /** Prefix for the durable step names; must be unique within the workflow. */
  stepPrefix: string;
  /** Human-readable label for log lines. */
  label: string;
  /**
   * Reads the entities and splits them into the rows it saw plus the subset of
   * `ids` that are NOT yet ready. Only entities the scoped read actually
   * returns are considered — an id the read doesn't return (deleted, or
   * another team's private row) is treated as "not pending" so we never wait
   * the full timeout for something matching will skip anyway.
   */
  check: () => Promise<{ rows: TRow[]; pendingIds: string[] }>;
  onWaitNeeded?: OnWaitNeeded;
};

async function pollUntilReady<TRow extends Rpc.Serializable<TRow>>(
  step: WorkflowStep,
  { ids, stepPrefix, label, check, onWaitNeeded }: PollArgs<TRow>
): Promise<WaitForSheetsResult<TRow>> {
  if (ids.length === 0) {
    return { ready: true, pendingIds: [], rows: [] };
  }

  let rows: TRow[] = [];
  let pendingIds: string[] = ids;
  let notifiedWaiting = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const checked = await step.do(`${stepPrefix}-check-${attempt}`, async () =>
      check()
    );
    rows = checked.rows;
    pendingIds = checked.pendingIds;

    if (pendingIds.length === 0) {
      return { ready: true, pendingIds: [], rows };
    }

    // First time we discover we actually have to wait, fire the hook once.
    // Guarding with `notifiedWaiting` keeps the step name unique per run (a
    // duplicate `step.do` name would throw).
    if (onWaitNeeded && !notifiedWaiting) {
      notifiedWaiting = true;
      const waitingCount = pendingIds.length;
      await step.do(`${stepPrefix}-notify-waiting`, async () => {
        await onWaitNeeded(waitingCount);
        return { notified: true };
      });
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await step.sleep(`${stepPrefix}-wait-${attempt}`, POLL_INTERVAL);
    }
  }

  logger.warn(
    `[wait-for-sheets] Timed out waiting for ${label} after ${MAX_ATTEMPTS} attempts; proceeding with ${pendingIds.length} still pending`,
    { pendingIds }
  );
  return { ready: false, pendingIds, rows };
}

/** Element vision statuses that are still in flight (not terminal). */
const ELEMENT_VISION_IN_FLIGHT = new Set(['pending', 'analyzing']);

/**
 * Block until every element in `elementIds` has a terminal vision status
 * (`completed`/`failed`), or the timeout expires.
 *
 * Elements uploaded while creating a sequence kick off
 * `/element-vision` (a separate, fire-and-forget workflow) which writes the
 * element's `description`/`consistencyTag` and flips `visionStatus` from
 * `pending` → `analyzing` → `completed`. The analyze pipeline reads those
 * descriptions when it builds the element bible for scene-split, so a still-
 * running vision means the element is fed into generation with no description.
 *
 * `elementIds` is the run's trigger-time element set, NOT a live enumeration:
 * an element uploaded after generation started is not part of this run, and
 * scanning for it here would make its pending vision hard-fail the run at the
 * `load-elements` guard.
 *
 * We first scan those ids for the ones still in flight, then poll only those —
 * completed/failed elements never enter the wait set, so a sequence whose
 * vision already finished short-circuits with no added latency.
 *
 * `rows` is every element the wait read — the scan's rows, overlaid with the
 * final poll's — so the caller consumes them instead of reading again (#1113).
 */
export async function waitForElementVision(
  step: WorkflowStep,
  scopedDb: WaitForSheetsReadDb,
  elementIds: string[],
  opts?: { onWaitNeeded?: OnWaitNeeded }
): Promise<WaitForSheetsResult<SequenceElement>> {
  // Renamed from `wait-element-vision-scan`, which cached ids, not rows: a run
  // replaying across the #1113 deploy re-scans instead of reading that shape.
  const scanned = await step.do('wait-element-vision-scan-rows', async () =>
    scopedDb.sequenceElements.listByIds(elementIds)
  );
  const inFlightIds = scanned
    .filter((el) => ELEMENT_VISION_IN_FLIGHT.has(el.visionStatus))
    .map((el) => el.id);

  const polled = await pollUntilReady(step, {
    ids: inFlightIds,
    stepPrefix: 'wait-element-vision',
    label: 'element vision',
    onWaitNeeded: opts?.onWaitNeeded,
    check: async () => {
      const rows = await scopedDb.sequenceElements.listByIds(inFlightIds);
      return {
        rows,
        pendingIds: rows
          .filter((el) => ELEMENT_VISION_IN_FLIGHT.has(el.visionStatus))
          .map((el) => el.id),
      };
    },
  });
  const latest = new Map(polled.rows.map((el) => [el.id, el]));
  return {
    ...polled,
    rows: scanned.map((el) => latest.get(el.id) ?? el),
  };
}
