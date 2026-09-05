/**
 * Durable "wait for sheet generation" helpers for the matching workflows.
 *
 * When a user adds new talent or a new location while creating a sequence
 * (`TalentSuggestionSelector` → `createTalentFn`,
 * `LocationSuggestionSelector` → `createLibraryLocationFn`), the sheet /
 * reference-image generation runs in a *separate*, fire-and-forget workflow
 * (`/library-talent-sheet`, `/library-location-sheet`). The sequence's
 * `analyze-script-workflow` then spawns `talent-matching` / `location-matching`
 * which read those sheets:
 *
 *   - talent matching uses `talent.defaultSheet?.imageUrl` as the casting
 *     reference image, and
 *   - location matching SKIPS any library location without a
 *     `referenceImageUrl`.
 *
 * If the sheet workflow hasn't finished by the time matching reads the row, the
 * pre-cast talent gets an empty reference image (so the character no longer
 * looks like the chosen person) and the pre-selected location is dropped from
 * matching entirely. This helper closes that race by polling the DB in a
 * durable loop until every still-pending entity has its sheet — bounded by a
 * timeout so a sheet that failed to generate can't stall the whole pipeline.
 *
 * The poll uses `step.do` (durable, replay-safe) for each read and `step.sleep`
 * between reads, mirroring the batched-polling pattern in `motion-workflow.ts`.
 */

import type {
  LibraryLocation,
  SequenceElement,
  TalentWithSheets,
} from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/shared/observability/logger';
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'wait-for-sheets']);

/**
 * The three polling reads these helpers make. Narrowed so callers hand over
 * `scopedDb.liveRead` — polling a sibling workflow's late writes is one of the
 * sanctioned live reads, and this type is what says so at the boundary.
 */
export type WaitForSheetsReadDb = {
  talent: Pick<ScopedDb['talent'], 'getByIds'>;
  locations: Pick<ScopedDb['locations'], 'getByIds'>;
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

/**
 * Block until every requested talent has a usable default sheet image, or the
 * timeout expires. Talent without a sheet (newly created, generation still in
 * flight) are polled; talent that already have one short-circuit on the first
 * read so existing/library talent add no latency.
 */
export async function waitForTalentSheets(
  step: WorkflowStep,
  scopedDb: WaitForSheetsReadDb,
  talentIds: string[],
  opts?: { onWaitNeeded?: OnWaitNeeded }
): Promise<WaitForSheetsResult<TalentWithSheets>> {
  return pollUntilReady(step, {
    ids: talentIds,
    stepPrefix: 'wait-talent-sheets',
    label: 'talent sheets',
    onWaitNeeded: opts?.onWaitNeeded,
    check: async () => {
      const rows = await scopedDb.talent.getByIds(talentIds);
      return {
        rows,
        pendingIds: rows
          .filter((t) => !t.defaultSheet?.imageUrl)
          .map((t) => t.id),
      };
    },
  });
}

/**
 * Block until every requested library location has a reference image, or the
 * timeout expires. A location created with an uploaded reference image has one
 * immediately (short-circuit); one created from name/description only gets it
 * once `/library-location-sheet` finishes.
 */
export async function waitForLocationReferences(
  step: WorkflowStep,
  scopedDb: WaitForSheetsReadDb,
  locationIds: string[],
  opts?: { onWaitNeeded?: OnWaitNeeded }
): Promise<WaitForSheetsResult<LibraryLocation>> {
  return pollUntilReady(step, {
    ids: locationIds,
    stepPrefix: 'wait-location-refs',
    label: 'location references',
    onWaitNeeded: opts?.onWaitNeeded,
    check: async () => {
      const rows = await scopedDb.locations.getByIds(locationIds);
      return {
        rows,
        pendingIds: rows.filter((l) => !l.referenceImageUrl).map((l) => l.id),
      };
    },
  });
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
 */
export async function waitForElementVision(
  step: WorkflowStep,
  scopedDb: WaitForSheetsReadDb,
  elementIds: string[],
  opts?: { onWaitNeeded?: OnWaitNeeded }
): Promise<WaitForSheetsResult<SequenceElement>> {
  const inFlightIds = await step.do('wait-element-vision-scan', async () => {
    const elements = await scopedDb.sequenceElements.listByIds(elementIds);
    return elements
      .filter((el) => ELEMENT_VISION_IN_FLIGHT.has(el.visionStatus))
      .map((el) => el.id);
  });

  return pollUntilReady(step, {
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
}
