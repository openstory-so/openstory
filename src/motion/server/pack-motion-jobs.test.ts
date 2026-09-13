import { describe, expect, it } from 'vitest';
import type { ImageToVideoModel } from '@/models/models';
import {
  batchPacksInClipMultiShot,
  packMotionBatchShots,
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
  it('packs a 4s+6s Seedance scene into one 10s generation', () => {
    const packed = packMotionBatchShots(
      [shot('a', 'sc-1', 4), shot('b', 'sc-1', 6)],
      ['seedance_v2']
    );
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({
      shotId: 'a',
      duration: 10,
    });
    expect(packed[0]?.coveredShots?.map((s) => s.shotId)).toEqual(['a', 'b']);
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

  it('packs two 4s+6s scenes into two 10s generations', () => {
    const packed = packMotionBatchShots(
      [
        shot('a', 'sc-1', 4),
        shot('b', 'sc-1', 6),
        shot('c', 'sc-2', 4),
        shot('d', 'sc-2', 6),
      ],
      ['kling_v3_pro']
    );
    expect(packed).toHaveLength(2);
    expect(packed[0]?.shotId).toBe('a');
    expect(packed[0]?.duration).toBe(10);
    expect(packed[1]?.shotId).toBe('c');
    expect(packed[1]?.duration).toBe(10);
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
});
