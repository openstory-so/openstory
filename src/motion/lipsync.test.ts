import { describe, expect, it } from 'vitest';
import { usdToMicros } from '@/billing/money';
import {
  LIPSYNC_SYNC_MODE,
  estimateLipsyncCost,
  lipsyncFalInput,
  lipsyncManifest,
  planLipsync,
  planMotionLipsync,
} from './lipsync';

const entry = {
  shotId: 'shot-1',
  motionPromptVersionId: 'mp-1',
  frameVersionId: 'fv-1',
  usesStartFrame: true,
  durationMs: 5000,
  audioClipIds: ['old'],
  audioSourceKey: 'old-key',
  dialogueKey: 'line',
  referenceKeys: ['character:c:sheet'],
};

const clip = {
  id: 'section-1',
  url: 'https://cdn.test/line.mp3',
  sourceKey: 'voice\tStay down.\t\televen_v3',
  durationSeconds: 4,
};

describe('estimateLipsyncCost', () => {
  it('prices sync-3 at $8 per minute of the clip', () => {
    expect(estimateLipsyncCost(5)).toBe(usdToMicros((5 / 60) * 8));
    expect(estimateLipsyncCost(0)).toBe(usdToMicros((5 / 60) * 8));
  });
});

describe('lipsyncFalInput', () => {
  it('sends the clip and the section and cuts the audio off', () => {
    expect(lipsyncFalInput('https://v', 'https://a')).toEqual({
      video_url: 'https://v',
      audio_url: 'https://a',
      sync_mode: LIPSYNC_SYNC_MODE,
    });
  });
});

describe('lipsyncManifest', () => {
  it('restamps only the synced shot audio', () => {
    const other = { ...entry, shotId: 'shot-2', audioSourceKey: 'keep' };
    const next = lipsyncManifest([entry, other], 'shot-1', {
      clipIds: ['section-1'],
      sourceKey: 'new-key',
    });
    expect(next[0]).toMatchObject({
      audioClipIds: ['section-1'],
      audioSourceKey: 'new-key',
      motionPromptVersionId: 'mp-1',
      referenceKeys: ['character:c:sheet'],
    });
    expect(next[1]?.audioSourceKey).toBe('keep');
  });
});

describe('planLipsync', () => {
  const ready = {
    shotId: 'shot-1',
    renderSegmentId: 'seg-1',
    selected: {
      url: 'https://cdn.test/clip.mp4',
      status: 'completed',
      resolution: '720p' as const,
      manifest: [entry],
    },
    generating: false,
    clips: [clip],
    shotDurationMs: 5000,
  };

  it('plans one clip against one dialogue file', () => {
    const planned = planLipsync(ready);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.audioUrl).toBe(clip.url);
    expect(planned.plan.sourceKey).toBe(clip.sourceKey);
    expect(planned.plan.durationSeconds).toBe(5);
    expect(planned.plan.manifest[0]?.audioSourceKey).toBe(clip.sourceKey);
    expect(planned.plan.cost).toBe(estimateLipsyncCost(5));
  });

  it('refuses a packed clip, a second file, and a take that was never keyed', () => {
    expect(
      planLipsync({
        ...ready,
        selected: {
          ...ready.selected,
          manifest: [entry, { ...entry, shotId: 'shot-2' }],
        },
      }).ok
    ).toBe(false);
    expect(
      planLipsync({
        ...ready,
        clips: [clip, { ...clip, id: 'other', url: 'https://cdn.test/b.mp3' }],
      })
    ).toMatchObject({ ok: false, reason: 'many-clips' });
    expect(
      planLipsync({
        ...ready,
        clips: [{ ...clip, sourceKey: undefined }],
      })
    ).toMatchObject({ ok: false, reason: 'unkeyed-audio' });
    expect(planLipsync({ ...ready, generating: true })).toMatchObject({
      ok: false,
      reason: 'generating',
    });
  });
});

describe('planMotionLipsync', () => {
  const finished = {
    shotId: 'shot-1',
    renderSegmentId: 'seg-1',
    videoUrl: 'https://cdn.test/clip.mp4',
    resolution: '720p' as const,
    manifest: [entry],
    clips: [clip],
    shotDurationMs: 5000,
    draftPreview: false,
    packed: false,
    variantOnly: false,
  };

  it('syncs Kling, Omni Flash and Grok after a single-shot render', () => {
    for (const model of [
      'kling_v3_pro',
      'kling_v4',
      'gemini_omni_flash',
      'grok_imagine_video_1_5',
    ] as const) {
      expect(planMotionLipsync({ ...finished, model })?.audioUrl).toBe(
        clip.url
      );
    }
  });

  it('leaves models that already took the audio file', () => {
    for (const model of ['seedance_v2_5', 'minimax_h3_max'] as const) {
      expect(planMotionLipsync({ ...finished, model })).toBeNull();
    }
  });

  it('skips a draft, a packed clip and a variant-only take', () => {
    expect(
      planMotionLipsync({
        ...finished,
        model: 'kling_v4',
        draftPreview: true,
      })
    ).toBeNull();
    expect(
      planMotionLipsync({ ...finished, model: 'kling_v4', packed: true })
    ).toBeNull();
    expect(
      planMotionLipsync({ ...finished, model: 'kling_v4', variantOnly: true })
    ).toBeNull();
  });
});
