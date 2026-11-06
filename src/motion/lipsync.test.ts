import { describe, expect, it } from 'vitest';
import { usdToMicros } from '@/billing/money';
import {
  LIPSYNC_SYNC_MODE,
  estimateLipsyncCost,
  estimateMotionLipsyncCost,
  lipsyncVersionModel,
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

describe('lipsyncVersionModel', () => {
  it('keeps the selected render model', () => {
    expect(
      lipsyncVersionModel('gemini_omni_flash', [
        { model: 'kling_v4' },
        { model: 'sync-lipsync-3' },
      ])
    ).toBe('gemini_omni_flash');
  });

  it('uses the newest real video model when the selected row is a lip-sync', () => {
    expect(
      lipsyncVersionModel('sync-lipsync-3', [
        { model: 'kling_v4' },
        { model: 'gemini_omni_flash' },
        { model: 'sync-lipsync-3' },
      ])
    ).toBe('gemini_omni_flash');
  });
});

describe('estimateMotionLipsyncCost', () => {
  it('adds sync-3 for a speaking clip the model cannot take audio for', () => {
    expect(
      estimateMotionLipsyncCost({
        model: 'gemini_omni_flash',
        draft: false,
        durationSeconds: 10,
        speaks: true,
      })
    ).toBe(estimateLipsyncCost(10));
  });

  it('stays zero when the model uploads the file, the shot is silent, or it is a draft', () => {
    const base = {
      draft: false,
      durationSeconds: 10,
      speaks: true,
    };
    expect(estimateMotionLipsyncCost({ ...base, model: 'seedance_v2_5' })).toBe(
      0
    );
    expect(
      estimateMotionLipsyncCost({
        model: 'kling_v4',
        draft: false,
        durationSeconds: 10,
        speaks: false,
      })
    ).toBe(0);
    expect(
      estimateMotionLipsyncCost({
        model: 'grok_imagine_video_1_5',
        draft: true,
        durationSeconds: 10,
        speaks: true,
      })
    ).toBe(0);
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

  it('syncs a packed clip against its one dialogue file', () => {
    const second = { ...entry, shotId: 'shot-2', durationMs: 3000 };
    const planned = planMotionLipsync({
      ...finished,
      model: 'kling_v4',
      manifest: [entry, second],
      clips: [
        {
          ...clip,
          id: 'section-1+section-2',
          durationSeconds: 8,
          sourceKey: undefined,
        },
      ],
    });
    expect(planned?.audioUrl).toBe(clip.url);
    expect(planned?.durationSeconds).toBe(8);
    expect(planned?.manifest).toHaveLength(2);
    expect(planned?.manifest[0]?.audioClipIds).toEqual(entry.audioClipIds);
    expect(planned?.manifest[1]?.audioSourceKey).toBe(second.audioSourceKey);
  });

  it('skips a packed clip that did not collapse to one dialogue file', () => {
    expect(
      planMotionLipsync({
        ...finished,
        model: 'kling_v4',
        manifest: [entry, { ...entry, shotId: 'shot-2' }],
        clips: [clip, { ...clip, id: 'other', url: 'https://cdn.test/b.mp3' }],
      })
    ).toBeNull();
  });

  it('skips a draft and a variant-only take', () => {
    expect(
      planMotionLipsync({
        ...finished,
        model: 'kling_v4',
        draftPreview: true,
      })
    ).toBeNull();
    expect(
      planMotionLipsync({ ...finished, model: 'kling_v4', variantOnly: true })
    ).toBeNull();
  });
});
