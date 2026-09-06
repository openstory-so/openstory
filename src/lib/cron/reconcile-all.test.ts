/**
 * Tests for the broad cron sweep — focused on the highest-risk paths:
 * the blind-fail passes (mass-mutation without run-state verification) and
 * pass isolation (one bad pass must not wedge the rest of the sweep).
 *
 * Drizzle is mocked at the call-chain level. We assert behaviour (which
 * call was made with what payload) rather than the generated SQL — that
 * keeps the tests robust to drizzle internals while still catching the
 * regressions the PR review called out (copy-paste of status literals,
 * wrong column on the update, missing pass isolation).
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  framePromptVersions,
  frameVariants,
  generatedAssets,
  shotPromptVersions,
  shotVariants,
  shots,
  sequenceElements,
  sequences,
} from '@/lib/db/schema';

// Claim tables included so #1085 pass assertions can match on table identity.
type SchemaTable =
  | typeof shots
  | typeof shotVariants
  | typeof sequences
  | typeof sequenceElements
  | typeof generatedAssets
  | typeof framePromptVersions
  | typeof shotPromptVersions
  | typeof frameVariants;
type SetPayload = Record<string, Date | string>;
type UpdateCall = {
  table: SchemaTable;
  payload: SetPayload;
  returning: boolean;
};

const updateCalls: UpdateCall[] = [];
let limitArgs: number[] = [];

let stuckRows: Array<{ id: string; runId: string | null }> = [];
/** When set, only this table's verified select returns stuckRows (others []). */
let stuckSelectTable: SchemaTable | null = null;
/**
 * Claim verified paths call `.returning()` once per table, then the orphan
 * path calls it again. Only the first call on stuckSelectTable should echo
 * stuck ids — otherwise orphan would cascade/fail the same rows again.
 */
const verifiedReturningServed = new Set<SchemaTable>();
let blindFailReturning: Array<{ id: string }> = [];
let nextSelectThrows: Error | null = null;

const dbMock = {
  select: () => ({
    from: (table: SchemaTable) => ({
      where: () => ({
        limit: async (n: number) => {
          limitArgs.push(n);
          if (nextSelectThrows) {
            const err = nextSelectThrows;
            nextSelectThrows = null;
            throw err;
          }
          if (stuckSelectTable && table !== stuckSelectTable) return [];
          return stuckRows;
        },
      }),
    }),
  }),
  update: (table: SchemaTable) => ({
    set: (payload: SetPayload) => ({
      // The real `.where(condition)` returns a thenable that also exposes
      // `.returning(...)`. Per-row updates `await` it; status-guarded claim
      // fails and blind-fail passes call `.returning(...)` instead.
      where: () => ({
        // oxlint-disable-next-line no-thenable -- mocking drizzle's chain
        then(resolve: (value: undefined) => void) {
          updateCalls.push({ table, payload, returning: false });
          resolve(undefined);
        },
        returning: async () => {
          updateCalls.push({ table, payload, returning: true });
          if (blindFailReturning.length > 0) return blindFailReturning;
          // Status-guarded verified claim update (first returning on the
          // stuck table after a terminal run-state lookup).
          if (
            stuckSelectTable &&
            table === stuckSelectTable &&
            (runStateResult === 'failed' || runStateResult === 'completed') &&
            !verifiedReturningServed.has(table)
          ) {
            verifiedReturningServed.add(table);
            return stuckRows.map((r) => ({ id: r.id }));
          }
          return [];
        },
      }),
    }),
  }),
};

vi.doMock('#db-client', () => ({ getDb: () => dbMock }));

// resolveRunState stub: defaults to "still in flight" (null) — verified
// passes are no-ops unless a test overrides `runStateResult`.
let runStateResult: 'failed' | 'completed' | 'unknown' | null = null;
vi.doMock('@/lib/workflow/reconcile', () => ({
  resolveRunState: async () => runStateResult,
  STALE_THRESHOLD_MS: 5 * 60 * 1000,
}));

beforeEach(() => {
  updateCalls.length = 0;
  limitArgs = [];
  stuckRows = [];
  stuckSelectTable = null;
  verifiedReturningServed.clear();
  blindFailReturning = [];
  nextSelectThrows = null;
  runStateResult = null;
});

describe('reconcileAllStuckJobs — blind-fail passes', () => {
  test('sequences.music writes musicStatus=failed', async () => {
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const musicUpdate = updateCalls.find(
      (c) => c.table === sequences && 'musicStatus' in c.payload
    );
    expect(musicUpdate).toBeDefined();
    expect(musicUpdate?.payload.musicStatus).toBe('failed');
    expect(musicUpdate?.returning).toBe(true);
    expect(counts['sequences.music']).toBe(1);
  });

  test('sequence_elements.vision writes visionStatus=failed', async () => {
    blindFailReturning = [{ id: 'el_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const visionUpdate = updateCalls.find(
      (c) => c.table === sequenceElements && 'visionStatus' in c.payload
    );
    expect(visionUpdate).toBeDefined();
    expect(visionUpdate?.payload.visionStatus).toBe('failed');
  });

  test('update payloads do NOT bump updated_at (so sequential passes still see the row as stale)', async () => {
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    for (const call of updateCalls) {
      expect('updatedAt' in call.payload).toBe(false);
    }
  });
});

describe('reconcileAllStuckJobs — pass isolation', () => {
  test('a throwing select in one pass does not stop later passes', async () => {
    nextSelectThrows = new Error('simulated D1 outage');
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs, PASS_ERRORED } =
      await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    // The first (now-throwing) pass is the frame image pass (#989 moved image
    // off shots onto frames/frame_variants).
    expect(counts['frames.image']).toBe(PASS_ERRORED);
    expect(counts['sequences.music']).toBeGreaterThan(0);
    expect(counts['sequence_elements.vision']).toBeGreaterThan(0);
  });
});

describe('reconcileAllStuckJobs — run-id-verified passes', () => {
  test('caps stuck-row selection at MAX_ROWS_PER_PASS (100) per verified pass', async () => {
    const { reconcileAllStuckJobs } = await import('./reconcile-all');
    await reconcileAllStuckJobs();
    // 10 verified (run-id) passes: frames.image + frame_variants.status +
    // video_variants.status (#1076) + 2 shot_variants + sequences.status (#989)
    // + generated_assets.status (#458) + the three pending-claim passes (#1085:
    // frame/shot prompt claims + image claims). The old shots.video pass went
    // with the shot's video columns — video_variants.status already swept it.
    expect(limitArgs.filter((n) => n === 100)).toHaveLength(10);
  });

  test('in-flight instance (resolveRunState null) → no per-row update on verified tables', async () => {
    stuckRows = [{ id: 'frm_1', runId: 'wf_running' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const verifiedTables: SchemaTable[] = [shots, shotVariants, sequences];
    const verifiedUpdates = updateCalls.filter(
      (c) => verifiedTables.includes(c.table) && !('musicStatus' in c.payload) // sequences.music is blind-fail, not verified
    );
    expect(verifiedUpdates).toHaveLength(0);
  });

  test("status lookup failed (resolveRunState 'unknown') → no per-row update on verified tables", async () => {
    stuckRows = [{ id: 'frm_1', runId: 'wf_unreachable' }];
    runStateResult = 'unknown';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const verifiedTables: SchemaTable[] = [shots, shotVariants, sequences];
    const verifiedUpdates = updateCalls.filter(
      (c) => verifiedTables.includes(c.table) && !('musicStatus' in c.payload) // sequences.music is blind-fail, not verified
    );
    expect(verifiedUpdates).toHaveLength(0);
  });
});

describe('reconcileAllStuckJobs — sequences.status pass (#839)', () => {
  test('dead storyboard run → status=failed with a retryable statusError', async () => {
    stuckRows = [{ id: 'seq_1', runId: 'openstory-so_storyboard_dead' }];
    runStateResult = 'failed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const statusUpdate = updateCalls.find(
      (c) => c.table === sequences && c.payload.status === 'failed'
    );
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate?.payload.statusError).toMatch(/Retry/);
    expect(counts['sequences.status']).toBeGreaterThan(0);
  });

  test('completed storyboard run → status=completed', async () => {
    stuckRows = [{ id: 'seq_1', runId: 'openstory-so_storyboard_done' }];
    runStateResult = 'completed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const statusUpdate = updateCalls.find(
      (c) => c.table === sequences && c.payload.status === 'completed'
    );
    expect(statusUpdate).toBeDefined();
    expect('statusError' in (statusUpdate?.payload ?? {})).toBe(false);
  });
});

describe('reconcileAllStuckJobs — generated_assets passes (#458)', () => {
  test('dead asset run → status=failed with a retry hint', async () => {
    stuckRows = [{ id: 'ga_1', runId: 'openstory-so_asset_dead' }];
    runStateResult = 'failed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const update = updateCalls.find(
      (c) => c.table === generatedAssets && c.payload.status === 'failed'
    );
    expect(update).toBeDefined();
    expect(update?.payload.error).toMatch(/run it again/);
    expect(counts['generated_assets.status']).toBeGreaterThan(0);
  });

  test('completed instance with an unflipped row → failed (never completed without outputs)', async () => {
    stuckRows = [{ id: 'ga_1', runId: 'openstory-so_asset_done' }];
    runStateResult = 'completed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const update = updateCalls.find((c) => c.table === generatedAssets);
    expect(update?.payload.status).toBe('failed');
    expect(update?.payload.error).toMatch(/was not saved/);
  });

  test('orphan pass blind-fails queued rows with no run id', async () => {
    blindFailReturning = [{ id: 'ga_orphan' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const update = updateCalls.find(
      (c) =>
        c.table === generatedAssets &&
        c.returning &&
        c.payload.status === 'failed'
    );
    expect(update).toBeDefined();
    expect(update?.payload.error).toMatch(/could not be started/);
    expect(counts['generated_assets.orphaned']).toBe(1);
  });
});

describe('reconcileAllStuckJobs — pending artifact claim passes (#1085)', () => {
  test('terminal instance → prompt claim failed via returning (status-guarded)', async () => {
    stuckRows = [{ id: 'fpv_1', runId: 'openstory-so_frame-prompt_dead' }];
    stuckSelectTable = framePromptVersions;
    runStateResult = 'failed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const claimFail = updateCalls.find(
      (c) =>
        c.table === framePromptVersions &&
        c.returning &&
        c.payload.status === 'failed'
    );
    expect(claimFail).toBeDefined();
    // Always 'failed' — never completes a claim from the reconciler.
    expect(claimFail?.payload.status).toBe('failed');
    expect(counts['frame_prompt_versions.claims']).toBeGreaterThan(0);
    // Frame-side cascade cancels live dependents (non-returning update).
    const cascade = updateCalls.find(
      (c) =>
        c.table === frameVariants &&
        !c.returning &&
        c.payload.status === 'cancelled'
    );
    expect(cascade).toBeDefined();
    expect(cascade?.payload.error).toMatch(/Upstream visual prompt/);
  });

  test('unknown / in-flight instance → no claim fail write', async () => {
    stuckRows = [{ id: 'fpv_1', runId: 'openstory-so_frame-prompt_running' }];
    stuckSelectTable = framePromptVersions;
    runStateResult = null;
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    // Verified path continues without UPDATE; orphan returns no rows for this
    // mock when runState is non-terminal. Count stays 0 (the orphan UPDATE
    // statement may still be issued — where would match nothing in real D1).
    expect(counts['frame_prompt_versions.claims']).toBe(0);
    const cascade = updateCalls.find(
      (c) =>
        c.table === frameVariants &&
        !c.returning &&
        c.payload.status === 'cancelled'
    );
    expect(cascade).toBeUndefined();
  });

  test('shot prompt claim fail does not cascade frame variants', async () => {
    stuckRows = [{ id: 'spv_1', runId: 'openstory-so_motion-prompt_dead' }];
    stuckSelectTable = shotPromptVersions;
    runStateResult = 'failed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const shotClaimFail = updateCalls.find(
      (c) =>
        c.table === shotPromptVersions &&
        c.returning &&
        c.payload.status === 'failed'
    );
    expect(shotClaimFail).toBeDefined();
    const cascade = updateCalls.find(
      (c) => c.table === frameVariants && c.payload.status === 'cancelled'
    );
    expect(cascade).toBeUndefined();
  });

  test('image claim terminal instance → failed with reason, returning-guarded', async () => {
    stuckRows = [{ id: 'fv_1', runId: 'openstory-so_image_dead' }];
    stuckSelectTable = frameVariants;
    runStateResult = 'completed'; // still failed: claim never completed content
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const imageClaimFail = updateCalls.find(
      (c) =>
        c.table === frameVariants &&
        c.returning &&
        c.payload.status === 'failed' &&
        typeof c.payload.error === 'string' &&
        /died before starting/.test(c.payload.error)
    );
    expect(imageClaimFail).toBeDefined();
    expect(counts['frame_variants.claims']).toBeGreaterThan(0);
  });

  test('orphan prompt claim (no run id) blind-fails after longer threshold', async () => {
    blindFailReturning = [{ id: 'fpv_orphan' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const orphanFail = updateCalls.find(
      (c) =>
        c.table === framePromptVersions &&
        c.returning &&
        c.payload.status === 'failed'
    );
    expect(orphanFail).toBeDefined();
    expect(counts['frame_prompt_versions.claims']).toBeGreaterThan(0);
  });
});
