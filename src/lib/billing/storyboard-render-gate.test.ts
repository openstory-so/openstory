/**
 * Grow-or-stop before stills/motion (#1310).
 *
 * After scene-split the remaining work is actual N stills + optional motion
 * and music. If the click envelope cannot grow to cover it, shot-images and
 * motion-batch must not spawn.
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { describe, expect, it, vi } from 'vitest';
import { micros, ZERO_MICROS } from './money';

const reportReservationShort = vi.fn();
vi.doMock('./billing-observability', () => ({
  reportReservationShort,
}));

const { gateStoryboardRenders } = await import('./storyboard-render-gate');

function makeScopedDb(opts: { remaining: number; growOk?: boolean }) {
  const growReservation = vi.fn(async (_id: string, extra: number) => {
    if (extra <= 0) {
      return { ok: true as const, remaining: micros(opts.remaining) };
    }
    if (opts.growOk === false) return { ok: false as const };
    return {
      ok: true as const,
      remaining: micros(opts.remaining + extra),
    };
  });
  const zeroReservation = vi.fn().mockResolvedValue(undefined);
  const checkAutoTopUp = vi.fn().mockResolvedValue(undefined);
  const stub = {
    teamId: 'team_1',
    billing: { growReservation, zeroReservation, checkAutoTopUp },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- gate only touches billing
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, growReservation, zeroReservation, checkAutoTopUp };
}

describe('gateStoryboardRenders', () => {
  it('spawns without touching billing when there is no envelope (BYOK)', async () => {
    const { scopedDb, growReservation } = makeScopedDb({ remaining: 0 });

    await expect(
      gateStoryboardRenders({
        scopedDb,
        remainingWork: micros(5_000_000),
        sceneCount: 12,
        sequenceId: 'seq_1',
      })
    ).resolves.toEqual({ spawnRenders: true });

    expect(growReservation).not.toHaveBeenCalled();
  });

  it('spawns without growing when remaining covers the render work', async () => {
    const { scopedDb, growReservation, zeroReservation } = makeScopedDb({
      remaining: 4_000_000,
    });

    await expect(
      gateStoryboardRenders({
        scopedDb,
        reservationId: 'res_1',
        remainingWork: micros(3_000_000),
        sceneCount: 8,
        sequenceId: 'seq_1',
      })
    ).resolves.toEqual({ spawnRenders: true });

    expect(growReservation).toHaveBeenCalledWith('res_1', ZERO_MICROS);
    expect(growReservation).toHaveBeenCalledTimes(1);
    expect(zeroReservation).not.toHaveBeenCalled();
  });

  it('grows by the shortfall and spawns when available funds cover it', async () => {
    const { scopedDb, growReservation, zeroReservation } = makeScopedDb({
      remaining: 1_000_000,
      growOk: true,
    });

    await expect(
      gateStoryboardRenders({
        scopedDb,
        reservationId: 'res_1',
        remainingWork: micros(4_000_000),
        sceneCount: 20,
        sequenceId: 'seq_1',
      })
    ).resolves.toEqual({ spawnRenders: true });

    expect(growReservation).toHaveBeenNthCalledWith(1, 'res_1', ZERO_MICROS);
    expect(growReservation).toHaveBeenNthCalledWith(
      2,
      'res_1',
      micros(3_000_000)
    );
    expect(zeroReservation).not.toHaveBeenCalled();
  });

  it('does not spawn, zeros leftover, and reports short when grow fails', async () => {
    reportReservationShort.mockClear();
    const { scopedDb, zeroReservation, checkAutoTopUp } = makeScopedDb({
      remaining: 1_000_000,
      growOk: false,
    });

    await expect(
      gateStoryboardRenders({
        scopedDb,
        reservationId: 'res_1',
        remainingWork: micros(4_000_000),
        sceneCount: 20,
        sequenceId: 'seq_1',
      })
    ).resolves.toEqual({
      spawnRenders: false,
      neededMicros: micros(3_000_000),
      remainingMicros: micros(1_000_000),
    });

    expect(zeroReservation).toHaveBeenCalledWith('res_1');
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
    expect(reportReservationShort).toHaveBeenCalledWith({
      teamId: 'team_1',
      sequenceId: 'seq_1',
      neededMicros: micros(3_000_000),
      remainingMicros: micros(1_000_000),
      sceneCount: 20,
    });
  });
});
