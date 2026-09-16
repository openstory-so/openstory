import { describe, expect, it } from 'vitest';
import type { ImageToVideoModel } from '@/models/models';
import {
  batchPacksInClipMultiShot,
  coveredMembersForShot,
  packMotionBatchShots,
  packPayloadDurationSeconds,
} from './pack-motion-jobs';

const shot = (
  shotId: string,
  sceneId: string,
  duration: number,
  model?: ImageToVideoModel
) => ({ shotId, sceneId, duration, model });

describe('batchPacksInClipMultiShot', () => {
  it('is true when every model can cut inside a clip', () => {
    expect(batchPacksInClipMultiShot(['seedance_v2', 'kling_v3_pro'])).toBe(
      true
    );
  });

  it('is false when Grok is in the batch', () => {
    expect(
      batchPacksInClipMultiShot(['seedance_v2', 'grok_imagine_video_1_5'])
    ).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(batchPacksInClipMultiShot([])).toBe(false);
  });
});

describe('packMotionBatchShots', () => {
  it('keeps a 4s+6s Seedance scene as independent generations', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)],
      ['seedance_v2']
    );
    expect(packed).toEqual([shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)]);
  });

  it('keeps Grok on one generation per shot', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)],
      ['grok_imagine_video_1_5']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed.every((s) => s.coveredShots === undefined)).toBe(true);
  });

  it('does not pack a mixed Seedance+Grok batch', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)],
      ['seedance_v2', 'grok_imagine_video_1_5']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
  });

  it('splits when the sum exceeds Omni Flash’s 10s cap', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 6), shot('b', 'sc-1', 6)],
      ['gemini_omni_flash']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed.every((s) => s.coveredShots === undefined)).toBe(true);
  });

  it('uses the tightest cap when packing models disagree', () => {
    // Seedance 2.5 can do 30s; Omni cannot. 6+6=12 must split for both.
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 6), shot('b', 'sc-1', 6)],
      ['seedance_v2_5', 'gemini_omni_flash']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
  });

  it('does not pack shots of different scenes together', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 4), shot('b', 'sc-2', 6)],
      ['seedance_v2']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
  });

  it('leaves a 1-shot scene as itself', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 8)],
      ['seedance_v2']
    );
    expect(packed).toEqual([shot('a', 'sc-1', 8)]);
  });

  it('packs short shots separately within each scene', () => {
    const packed = packMotionBatchShots(
      [
        shot('a', 'sc-1', 1),
        shot('b', 'sc-1', 2),
        shot('c', 'sc-2', 1),
        shot('d', 'sc-2', 2),
      ],
      ['kling_v3_pro']
    );
    expect(packed).toHaveLength(2);
    expect(packed[0]?.shotId).toBe('a');
    expect(packed[0]?.duration).toBe(3);
    expect(packed[1]?.shotId).toBe('c');
    expect(packed[1]?.duration).toBe(3);
  });

  it('falls back to each shot’s model when no top-level list is given', () => {
    const packed = packMotionBatchShots(
      [
        shot('a', 'sc-1', 4, 'grok_imagine_video_1_5'),
        shot('b', 'sc-1', 6, 'grok_imagine_video_1_5'),
      ],
      undefined
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
  });

  it('4s+6s H3 packs as one 10s job when each payload carries editorial seconds', () => {
    const packed = packMotionBatchShots(
      [
        shot('a', 'sc-1', packPayloadDurationSeconds(4000)),
        shot('b', 'sc-1', packPayloadDurationSeconds(6000)),
      ],
      ['minimax_h3_max']
    );
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({ shotId: 'a', duration: 10 });
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual(['a', 'b']);
  });

  it('writing the packed sum onto the clicked shot splits H3 4s+6s into two jobs', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 10), shot('b', 'sc-1', 6)],
      ['minimax_h3_max']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed.every((s) => s.coveredShots === undefined)).toBe(true);
  });

  it('omitting videoModels unpacks a Seedance pair next to a leftover Grok shot', () => {
    const shots = [
      shot('a', 'sc-1', 2, 'seedance_v2'),
      shot('b', 'sc-1', 2, 'seedance_v2'),
      shot('c', 'sc-2', 1, 'grok_imagine_video_1_5'),
    ];
    expect(
      packMotionBatchShots(shots, undefined).every((s) => !s.coveredShots)
    ).toBe(true);

    const packed = packMotionBatchShots(shots, ['seedance_v2']);
    expect(packed).toHaveLength(2);
    expect(packed[0]?.duration).toBe(4);
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed[1]?.shotId).toBe('c');
    expect(packed[1]?.coveredShots).toBeUndefined();
  });
});

describe('packMotionBatchShots — sticky membership', () => {
  it('does not absorb neighbours into a persisted 4-shot clip', () => {
    const packed = packMotionBatchShots(
      [
        { ...shot('a', 'sc-1', 2), renderSegmentId: 'seg-4' },
        { ...shot('b', 'sc-1', 2), renderSegmentId: 'seg-4' },
        { ...shot('c', 'sc-1', 2), renderSegmentId: 'seg-4' },
        { ...shot('d', 'sc-1', 2), renderSegmentId: 'seg-4' },
        shot('e', 'sc-1', 2),
        shot('f', 'sc-1', 2),
      ],
      ['seedance_v2']
    );
    expect(packed).toHaveLength(2);
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(packed[1]?.coveredShots?.map((s) => s.shotId)).toEqual(['e', 'f']);
  });

  it('does not pack a 1:1 rendered shot with unrendered neighbours', () => {
    const packed = packMotionBatchShots(
      [
        { ...shot('a', 'sc-1', 4), renderSegmentId: 'a' },
        shot('b', 'sc-1', 2),
        shot('c', 'sc-1', 2),
      ],
      ['seedance_v2']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed[0]?.coveredShots).toBeUndefined();
    expect(packed[1]?.coveredShots?.map((s) => s.shotId)).toEqual(['b', 'c']);
  });
});

describe('packMotionBatchShots — prompt length', () => {
  it('peels trailing shots when the assembled prompt would overflow', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 1), shot('b', 'sc-1', 1), shot('c', 'sc-1', 2)],
      ['seedance_v2'],
      {
        promptFits: (members) => members.length <= 2,
      }
    );
    expect(packed).toHaveLength(2);
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual(['a', 'b']);
    expect(packed[1]?.shotId).toBe('c');
    expect(packed[1]?.coveredShots).toBeUndefined();
  });

  it('does not peel a persisted clip when the prompt no longer fits', () => {
    const packed = packMotionBatchShots(
      [
        { ...shot('a', 'sc-1', 3), renderSegmentId: 'seg-4' },
        { ...shot('b', 'sc-1', 3), renderSegmentId: 'seg-4' },
        { ...shot('c', 'sc-1', 3), renderSegmentId: 'seg-4' },
        { ...shot('d', 'sc-1', 3), renderSegmentId: 'seg-4' },
      ],
      ['seedance_v2'],
      { promptFits: (members) => members.length <= 3 }
    );
    expect(packed).toHaveLength(1);
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('packMotionBatchShots — leftover min', () => {
  it('uses minimum H3 groups without leaving a short tail: [5][5][9]', () => {
    const shots = Array.from({ length: 19 }, (_, i) =>
      shot(`s${i}`, 'sc-1', 1)
    );
    const packed = packMotionBatchShots(shots, ['minimax_h3_max']);
    expect(packed).toHaveLength(3);
    expect(packed[0]?.coveredShots).toHaveLength(5);
    expect(packed[0]?.duration).toBe(5);
    expect(packed[1]?.coveredShots).toHaveLength(5);
    expect(packed[1]?.duration).toBe(5);
    expect(packed[2]?.coveredShots).toHaveLength(9);
    expect(packed[2]?.duration).toBe(9);
  });

  it('a Grok leftover shot does not pack into Seedance neighbours', () => {
    const packed = packMotionBatchShots(
      [
        shot('a', 'sc-1', 15, 'seedance_v2'),
        shot('b', 'sc-1', 1, 'grok_imagine_video_1_5'),
        shot('c', 'sc-1', 15, 'seedance_v2'),
      ],
      ['seedance_v2']
    );
    expect(packed.map((s) => s.shotId)).toEqual(['a', 'b', 'c']);
    expect(packed.every((s) => s.coveredShots === undefined)).toBe(true);
  });
});

describe('coveredMembersForShot', () => {
  it('returns both members when clicking either shot of a packed pair', () => {
    const shots = [shot('a', 'sc-1', 2), shot('b', 'sc-1', 2)];
    expect(
      coveredMembersForShot(shots, 'a', ['seedance_v2']).map((s) => s.shotId)
    ).toEqual(['a', 'b']);
    expect(
      coveredMembersForShot(shots, 'b', ['seedance_v2']).map((s) => s.shotId)
    ).toEqual(['a', 'b']);
  });

  it('returns only the clicked shot when Grok cannot pack', () => {
    const shots = [shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)];
    expect(
      coveredMembersForShot(shots, 'b', ['grok_imagine_video_1_5']).map(
        (s) => s.shotId
      )
    ).toEqual(['b']);
  });

  it('does not pull the next tile when the scene splits on the cap', () => {
    const shots = [
      shot('a', 'sc-1', 10),
      shot('b', 'sc-1', 10),
      shot('c', 'sc-1', 5),
    ];
    expect(
      coveredMembersForShot(shots, 'a', ['minimax_h3_max']).map((s) => s.shotId)
    ).toEqual(['a']);
  });

  it('regenerating a persisted 4-shot clip does not extend to 6', () => {
    const shots = [
      { ...shot('a', 'sc-1', 2), renderSegmentId: 'seg-4' },
      { ...shot('b', 'sc-1', 2), renderSegmentId: 'seg-4' },
      { ...shot('c', 'sc-1', 2), renderSegmentId: 'seg-4' },
      { ...shot('d', 'sc-1', 2), renderSegmentId: 'seg-4' },
      shot('e', 'sc-1', 2),
      shot('f', 'sc-1', 2),
    ];
    expect(
      coveredMembersForShot(shots, 'b', ['seedance_v2']).map((s) => s.shotId)
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
