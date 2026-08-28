/**
 * Behavioural test for the upscale promote step (#989 / #1129).
 *
 * `selectShotVariantFn` no longer writes the still synchronously — it triggers
 * this workflow, which upscales the chosen 3×3 tile and then promotes the
 * upscaled version to the frame's primary still. The promote rides the
 * auto-promote claim minted at kickoff (#1070), NOT a bare `frameVariants.select`:
 * an upscale runs for minutes, and a still the user picks from history in the
 * meantime clears the claim and must win. The e2e suite can't observe that async
 * promote hermetically, so the outcome is pinned here: `persistUpscaleSelection`
 * completes the in-flight version and promotes the TRIGGER's frame (never
 * re-resolved from the shot) only while the claim still points at this version —
 * on a miss the upscale stays in history and the frame is left alone.
 *
 * The new still no longer drops the segment's chosen render (#1067 phase 2d):
 * the old video keeps playing and the manifest-staleness system flags it.
 */

import type { Frame, NewFrame, NewFrameVariant } from '@/lib/db/schema';
import { frameFixture, frameVariantFixture } from '@/lib/mocks/frame-fixtures';
import { describe, expect, it } from 'vitest';
import {
  bindUpscaleVersion,
  persistUpscaleSelection,
  type BindUpscaleVersionScopedDb,
  type PersistUpscaleScopedDb,
} from './upscale-shot-variant-workflow';

type VariantUpdateCall = { versionId: string; data: Partial<NewFrameVariant> };
type PromoteCall = {
  frameId: string;
  versionId: string;
  actorId: string | null;
};
type StatusCall = {
  frameId: string;
  data: Pick<
    Partial<NewFrame>,
    'imageStatus' | 'imageWorkflowRunId' | 'imageError'
  >;
};
type CallName =
  | 'frameVariants.update'
  | 'frameVariants.selectIfPendingPromoteIs'
  | 'frames.setImageGenerationStatus';

function buildScopedDbSpy(
  opts: {
    claimMoved?: boolean;
    /** Live frame on a claim miss. Default: another run owns the claim. */
    liveFrame?: Pick<
      Frame,
      'pendingPromoteVersionId' | 'selectedImageVersionId'
    >;
  } = {}
): {
  scopedDb: PersistUpscaleScopedDb;
  variantUpdates: VariantUpdateCall[];
  promotes: PromoteCall[];
  statusUpdates: StatusCall[];
  callOrder: CallName[];
} {
  const variantUpdates: VariantUpdateCall[] = [];
  const promotes: PromoteCall[] = [];
  const statusUpdates: StatusCall[] = [];
  const callOrder: CallName[] = [];
  // The methods return full rows; the helper only reads truthiness and `.id`,
  // so the defaults carry the rest.
  const row = (id: string) =>
    frameVariantFixture({
      id,
      frameId: 'anchor-frame-id',
      sequenceId: 'seq-1',
    });
  const live = frameFixture({
    id: 'anchor-frame-id',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    pendingPromoteVersionId: 'other-ver',
    selectedImageVersionId: 'old-still',
    ...opts.liveFrame,
  });
  const scopedDb: PersistUpscaleScopedDb = {
    frameVariants: {
      update: async (versionId, data) => {
        variantUpdates.push({ versionId, data });
        callOrder.push('frameVariants.update');
        return row(versionId);
      },
      selectIfPendingPromoteIs: async (frameId, versionId, optsArg) => {
        promotes.push({ frameId, versionId, actorId: optsArg.actorId });
        callOrder.push('frameVariants.selectIfPendingPromoteIs');
        return opts.claimMoved ? null : row(versionId);
      },
    },
    frames: {
      setImageGenerationStatus: async (frameId, data) => {
        statusUpdates.push({ frameId, data });
        callOrder.push('frames.setImageGenerationStatus');
        return live;
      },
    },
    liveRead: {
      frames: {
        getById: async () => live,
      },
    },
  };
  return { scopedDb, variantUpdates, promotes, statusUpdates, callOrder };
}

const NOW = new Date('2026-06-26T00:00:00Z');

describe('persistUpscaleSelection', () => {
  it('completes the version, promotes it through the claim, emits the new still', async () => {
    const { scopedDb, variantUpdates, promotes, callOrder, statusUpdates } =
      buildScopedDbSpy();
    const emits: Array<{
      shotId: string;
      status: string;
      thumbnailUrl?: string;
    }> = [];

    const result = await persistUpscaleSelection({
      scopedDb,
      shotId: 'shot-1',
      frameId: 'anchor-frame-id',
      versionId: 'ver-1',
      url: 'https://r2/upscaled.png',
      path: 'team/seq/upscaled.png',
      actorId: 'user-1',
      generatedAt: NOW,
      emit: async (payload) => {
        emits.push(payload);
      },
    });

    expect(result).toEqual({
      promoted: true,
      thumbnailUrl: 'https://r2/upscaled.png',
    });

    // Version is completed BEFORE the claim-consuming promote.
    expect(callOrder).toEqual([
      'frameVariants.update',
      'frameVariants.selectIfPendingPromoteIs',
    ]);

    const [versionUpdate] = variantUpdates;
    if (!versionUpdate) throw new Error('expected frameVariants.update call');
    expect(versionUpdate.versionId).toBe('ver-1');
    expect(versionUpdate.data).toEqual({
      status: 'completed',
      url: 'https://r2/upscaled.png',
      storagePath: 'team/seq/upscaled.png',
      generatedAt: NOW,
      error: null,
    });

    // Promote targets the TRIGGER's frame id (≠ shotId), not the shot id.
    const [promote] = promotes;
    if (!promote) throw new Error('expected a promote call');
    expect(promote.frameId).toBe('anchor-frame-id');
    expect(promote.versionId).toBe('ver-1');
    expect(promote.actorId).toBe('user-1');

    expect(emits).toEqual([
      {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: 'https://r2/upscaled.png',
      },
    ]);
    // Promote path: `select()` mirrors imageStatus from the completed version.
    expect(statusUpdates).toHaveLength(0);
  });

  it('leaves the frame alone when the claim moved (manual selection wins)', async () => {
    const { scopedDb, variantUpdates, promotes, callOrder, statusUpdates } =
      buildScopedDbSpy({
        claimMoved: true,
      });
    const emits: Array<{
      shotId: string;
      status: string;
      thumbnailUrl?: string;
    }> = [];

    const result = await persistUpscaleSelection({
      scopedDb,
      shotId: 'shot-1',
      frameId: 'anchor-frame-id',
      versionId: 'ver-1',
      url: 'https://r2/upscaled.png',
      path: null,
      actorId: 'user-1',
      generatedAt: NOW,
      emit: async (payload) => {
        emits.push(payload);
      },
    });

    expect(result).toEqual({ promoted: false });
    // The version is still finished (it stays selectable from the picker), and
    // the promote was attempted but conceded — one WHERE-guarded write, no
    // read-then-select that could lose the race.
    expect(callOrder).toEqual([
      'frameVariants.update',
      'frameVariants.selectIfPendingPromoteIs',
    ]);
    expect(variantUpdates).toHaveLength(1);
    expect(promotes).toHaveLength(1);
    // Newer kickoff owns pending — don't wipe its generating flag or emit
    // completed (that would clear the newer overlay on the client).
    expect(statusUpdates).toHaveLength(0);
    expect(emits).toEqual([]);
  });

  it('settles imageStatus back to completed when the claim is gone (history select)', async () => {
    const { scopedDb, statusUpdates } = buildScopedDbSpy({
      claimMoved: true,
      liveFrame: {
        pendingPromoteVersionId: null,
        selectedImageVersionId: 'old-still',
      },
    });
    const emits: Array<{ shotId: string; status: string }> = [];

    await persistUpscaleSelection({
      scopedDb,
      shotId: 'shot-1',
      frameId: 'anchor-frame-id',
      versionId: 'ver-1',
      url: 'https://r2/upscaled.png',
      path: null,
      actorId: 'user-1',
      generatedAt: NOW,
      emit: async (payload) => {
        emits.push(payload);
      },
    });

    expect(statusUpdates).toEqual([
      {
        frameId: 'anchor-frame-id',
        data: {
          imageStatus: 'completed',
          imageWorkflowRunId: null,
          imageError: null,
        },
      },
    ]);
    expect(emits).toEqual([{ shotId: 'shot-1', status: 'completed' }]);
  });
});

describe('bindUpscaleVersion', () => {
  const base = {
    frameId: 'anchor-frame-id',
    sequenceId: 'seq-1',
    upscaleModel: 'nano_banana_2',
    sourceVariantId: 'sheet-1',
    promptVersionId: 'prompt-1',
    workflowRunId: 'run-1',
  };

  function spy(existing: { id: string } | 'absent') {
    const appends: unknown[] = [];
    const updates: Array<{ versionId: string; data: unknown }> = [];
    const claims: Array<{ frameId: string; versionId: string }> = [];
    const row = (id: string) =>
      frameVariantFixture({
        id,
        frameId: base.frameId,
        sequenceId: base.sequenceId,
      });
    const scopedDb: BindUpscaleVersionScopedDb = {
      claims: {
        frameVariants: {
          getById: async () =>
            existing === 'absent' ? null : row(existing.id),
        },
      },
      frameVariants: {
        update: async (versionId, data) => {
          updates.push({ versionId, data });
          return row(versionId);
        },
        appendVersion: async (data) => {
          appends.push(data);
          return row('minted-1');
        },
      },
      frames: {
        setPendingPromoteVersionId: async (frameId, versionId) => {
          if (versionId) claims.push({ frameId, versionId });
        },
      },
    };
    return { scopedDb, appends, updates, claims };
  }

  it('reuses the minted version and does not append or re-claim', async () => {
    const { scopedDb, appends, updates, claims } = spy({ id: 'ver-1' });
    await expect(
      bindUpscaleVersion({ scopedDb, versionId: 'ver-1', ...base })
    ).resolves.toBe('ver-1');
    expect(appends).toEqual([]);
    expect(claims).toEqual([]);
    expect(updates).toEqual([
      { versionId: 'ver-1', data: { workflowRunId: 'run-1' } },
    ]);
  });

  it('skips when the minted version is gone', async () => {
    const { scopedDb, appends, claims } = spy('absent');
    await expect(
      bindUpscaleVersion({ scopedDb, versionId: 'ver-gone', ...base })
    ).resolves.toBeNull();
    expect(appends).toEqual([]);
    expect(claims).toEqual([]);
  });

  it('mints and claims for a legacy payload with no versionId', async () => {
    const { scopedDb, appends, claims } = spy('absent');
    await expect(
      bindUpscaleVersion({ scopedDb, versionId: undefined, ...base })
    ).resolves.toBe('minted-1');
    expect(appends).toHaveLength(1);
    expect(claims).toEqual([
      { frameId: 'anchor-frame-id', versionId: 'minted-1' },
    ]);
  });
});
