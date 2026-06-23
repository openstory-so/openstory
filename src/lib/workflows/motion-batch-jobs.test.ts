import { describe, expect, it } from 'vitest';
import { type ImageToVideoModel } from '@/lib/ai/models';
import {
  groupShotsForRender,
  motionBatchTotalFailureMessage,
  type RenderShot,
} from './motion-batch-jobs';

const settled = (
  statuses: Array<'fulfilled' | 'rejected'>
): Array<{ status: 'fulfilled' | 'rejected' }> =>
  statuses.map((status) => ({ status }));

type Shot = { shotId: string; model?: ImageToVideoModel };

// kling_v3_pro supports multi-shot; veo3_1 does not (degrade path).
const MULTI: ImageToVideoModel = 'kling_v3_pro';
const SINGLE: ImageToVideoModel = 'veo3_1';

function renderShot(
  shotId: string,
  sceneDbId: string | null,
  shotNumber: number
): RenderShot<Shot> {
  return { shotId, sceneDbId, shotNumber };
}

describe('groupShotsForRender', () => {
  it('groups a multi-shot scene into ONE multi-shot unit on a capable model', () => {
    const units = groupShotsForRender(
      [
        renderShot('s0', 'sceneA', 1),
        renderShot('s1', 'sceneA', 2),
        renderShot('s2', 'sceneA', 3),
      ],
      MULTI
    );
    expect(units).toHaveLength(1);
    const unit = units[0];
    if (unit?.strategy !== 'multi-shot') throw new Error('expected multi-shot');
    expect(unit.sceneDbId).toBe('sceneA');
    expect(unit.shots.map((s) => s.shotId)).toEqual(['s0', 's1', 's2']);
  });

  it('orders a multi-shot unit by shotNumber regardless of input order', () => {
    const units = groupShotsForRender(
      [
        renderShot('s2', 'sceneA', 3),
        renderShot('s0', 'sceneA', 1),
        renderShot('s1', 'sceneA', 2),
      ],
      MULTI
    );
    const unit = units[0];
    if (unit?.strategy !== 'multi-shot') throw new Error('expected multi-shot');
    expect(unit.shots.map((s) => s.shotNumber)).toEqual([1, 2, 3]);
  });

  it('degrades a multi-shot scene to per-shot on a single-shot model', () => {
    const units = groupShotsForRender(
      [renderShot('s0', 'sceneA', 1), renderShot('s1', 'sceneA', 2)],
      SINGLE
    );
    expect(units.map((u) => u.strategy)).toEqual(['per-shot', 'per-shot']);
  });

  it('renders a single-shot scene per-shot even on a capable model', () => {
    const units = groupShotsForRender([renderShot('s0', 'sceneA', 1)], MULTI);
    expect(units).toHaveLength(1);
    expect(units[0]?.strategy).toBe('per-shot');
  });

  it('renders scene-less (legacy) shots per-shot, after scene units', () => {
    const units = groupShotsForRender(
      [
        renderShot('s0', 'sceneA', 1),
        renderShot('s1', 'sceneA', 2),
        renderShot('legacy', null, 1),
      ],
      MULTI
    );
    expect(units.map((u) => u.strategy)).toEqual(['multi-shot', 'per-shot']);
    const last = units[1];
    if (last?.strategy !== 'per-shot') throw new Error('expected per-shot');
    expect(last.shot.shotId).toBe('legacy');
  });

  it('preserves first-seen scene order across multiple scenes', () => {
    const units = groupShotsForRender(
      [
        renderShot('b0', 'sceneB', 1),
        renderShot('b1', 'sceneB', 2),
        renderShot('a0', 'sceneA', 1),
        renderShot('a1', 'sceneA', 2),
      ],
      MULTI
    );
    const sceneIds = units.map((u) =>
      u.strategy === 'multi-shot' ? u.sceneDbId : null
    );
    expect(sceneIds).toEqual(['sceneB', 'sceneA']);
  });
});

describe('motionBatchTotalFailureMessage', () => {
  it('flags total failure when every motion clip rejected', () => {
    const msg = motionBatchTotalFailureMessage(
      'seq1',
      settled(['rejected', 'rejected', 'rejected'])
    );
    expect(msg).toBe(
      'All 3 motion clip(s) failed for sequence seq1; no video was produced.'
    );
  });

  it('returns null on partial success (at least one clip rendered)', () => {
    expect(
      motionBatchTotalFailureMessage('seq1', settled(['rejected', 'fulfilled']))
    ).toBeNull();
  });

  it('returns null when all clips succeeded', () => {
    expect(
      motionBatchTotalFailureMessage(
        'seq1',
        settled(['fulfilled', 'fulfilled'])
      )
    ).toBeNull();
  });

  it('returns null when there was no motion work to do (music-only / empty batch)', () => {
    expect(motionBatchTotalFailureMessage('seq1', [])).toBeNull();
  });

  it('flags total failure for a single expected clip that rejected', () => {
    expect(motionBatchTotalFailureMessage('seq1', settled(['rejected']))).toBe(
      'All 1 motion clip(s) failed for sequence seq1; no video was produced.'
    );
  });
});
