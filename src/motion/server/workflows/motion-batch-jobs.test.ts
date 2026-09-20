import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL, type ImageToVideoModel } from '@/models/models';
import { packMotionBatchShots } from '@/motion/server/pack-motion-jobs';
import {
  dialogueClipSourceKey,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import { attachRecordedClips, buildMotionJobs } from './motion-batch-jobs';

type Shot = { shotId: string; model?: ImageToVideoModel };

const A: ImageToVideoModel = 'kling_v3_pro';
const B: ImageToVideoModel = 'seedance_v2';

const shots: Shot[] = [{ shotId: 'f0' }, { shotId: 'f1' }, { shotId: 'f2' }];

describe('buildMotionJobs', () => {
  it('expands each shot across every top-level video model (N×M jobs)', () => {
    const jobs = buildMotionJobs(shots, [A, B]);
    expect(jobs.length).toBe(shots.length * 2);
    // Shots keep their order; each shot gets one job per model.
    expect(jobs.map((j) => [j.shotIndex, j.model])).toEqual([
      [0, A],
      [0, B],
      [1, A],
      [1, B],
      [2, A],
      [2, B],
    ]);
    // The original shot object is carried through unchanged.
    expect(jobs[0]?.shot).toBe(shots[0]);
  });

  it('dedupes the top-level model list so a model is never billed twice per shot', () => {
    const oneShot: Shot[] = [{ shotId: 'f0' }];
    const jobs = buildMotionJobs(oneShot, [A, A, B, A]);
    expect(jobs.map((j) => j.model)).toEqual([A, B]);
  });

  it('keeps each (shotIndex, model) pair unique so child instance ids never collide', () => {
    const jobs = buildMotionJobs(shots, [A, B, A]);
    const keys = jobs.map((j) => `${j.shotIndex}:${j.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("falls back to each shot's own model when no top-level models are given", () => {
    const perShot: Shot[] = [
      { shotId: 'f0', model: A },
      { shotId: 'f1', model: B },
    ];
    expect(buildMotionJobs(perShot, undefined).map((j) => j.model)).toEqual([
      A,
      B,
    ]);
    // An empty list is treated the same as absent (single-model fallback).
    expect(buildMotionJobs(perShot, []).map((j) => j.model)).toEqual([A, B]);
  });

  it('falls back to DEFAULT_VIDEO_MODEL when a shot has no model and none are given', () => {
    const oneShot: Shot[] = [{ shotId: 'f0' }];
    const jobs = buildMotionJobs(oneShot, undefined);
    expect(jobs.map((j) => j.model)).toEqual([DEFAULT_VIDEO_MODEL]);
  });

  it('top-level models win over per-shot model', () => {
    const perShot: Shot[] = [{ shotId: 'f0', model: A }];
    expect(buildMotionJobs(perShot, [B]).map((j) => j.model)).toEqual([B]);
  });

  it('returns no jobs for no shots', () => {
    expect(buildMotionJobs([], [A, B])).toEqual([]);
  });

  it('keeps a leftover Grok shot on Grok even when the batch is Seedance', () => {
    const grok: ImageToVideoModel = 'grok_imagine_video_1_5';
    const mixed: Shot[] = [
      { shotId: 'a', model: B },
      { shotId: 'b', model: grok },
    ];
    expect(buildMotionJobs(mixed, [B]).map((j) => j.model)).toEqual([B, grok]);
  });
});

describe('packMotionBatchShots then buildMotionJobs (#1510)', () => {
  it('fans independent jobs for shots that already meet the minimum', () => {
    const sceneShots = [
      { shotId: 'a', sceneId: 'sc-1', duration: 4, model: B },
      { shotId: 'b', sceneId: 'sc-1', duration: 6, model: B },
    ];
    const packed = packMotionBatchShots(sceneShots, [B]);
    const jobs = buildMotionJobs(packed, [B]);
    expect(jobs.map((j) => [j.shot.shotId, j.model, j.shot.duration])).toEqual([
      ['a', B, 4],
      ['b', B, 6],
    ]);
  });

  it('a leftover Grok shot next to a Seedance pair still packs the pair when videoModels is Seedance', () => {
    const grok: ImageToVideoModel = 'grok_imagine_video_1_5';
    const sceneShots = [
      { shotId: 'a', sceneId: 'sc-1', duration: 2, model: B },
      { shotId: 'b', sceneId: 'sc-1', duration: 2, model: B },
      { shotId: 'c', sceneId: 'sc-2', duration: 1, model: grok },
    ];
    const packed = packMotionBatchShots(sceneShots, [B]);
    const jobs = buildMotionJobs(packed, [B]);
    expect(jobs.map((j) => [j.shot.shotId, j.model, j.shot.duration])).toEqual([
      ['a', B, 4],
      ['c', grok, 1],
    ]);
  });

  it('keeps two Grok jobs for the same scene', () => {
    const grok: ImageToVideoModel = 'grok_imagine_video_1_5';
    const sceneShots = [
      { shotId: 'a', sceneId: 'sc-1', duration: 4, model: grok },
      { shotId: 'b', sceneId: 'sc-1', duration: 6, model: grok },
    ];
    const packed = packMotionBatchShots(sceneShots, [grok]);
    const jobs = buildMotionJobs(packed, [grok]);
    expect(jobs.map((j) => j.shot.shotId)).toEqual(['a', 'b']);
  });
});

describe('attachRecordedClips (#1657)', () => {
  const voiced = (text: string) =>
    voicedDialogueLines(
      {
        presence: true,
        lines: [{ character: 'Ana', line: text, tone: 'calm' }],
      },
      [{ name: 'Ana', voiceId: 'voice-ana' }]
    );
  const clipFor = (id: string, text: string) => ({
    id,
    url: `/r2/${id}.wav`,
    token: 'DIALOGUE',
    durationSeconds: 2,
    sourceKey: dialogueClipSourceKey(voiced(text)),
  });

  it('hands a shot the clip its scene recording cut, and stops its child recording', () => {
    const context = [{ shotId: 's1' }];
    const input: {
      shotId: string;
      voicedLines: ReturnType<typeof voiced>;
      audioClips?: ReturnType<typeof clipFor>[];
      dialogueContext?: unknown;
    }[] = [
      { shotId: 's1', voicedLines: voiced('Hello.'), dialogueContext: context },
    ];
    const [shot] = attachRecordedClips(input, {
      s1: [clipFor('section-1', 'Hello.')],
    });
    expect(shot?.audioClips?.map((clip) => clip.id)).toEqual(['section-1']);
    // No context left: the child attaches, it does not record.
    expect(shot && 'dialogueContext' in shot).toBe(false);
  });

  it('leaves a shot alone when the recording missed it or spoke other words', () => {
    const context = [{ shotId: 's1' }];
    const shots = [
      { shotId: 's1', voicedLines: voiced('Hello.'), dialogueContext: context },
      { shotId: 's2', voicedLines: voiced('Bye.'), dialogueContext: context },
    ];
    const out = attachRecordedClips(shots, {
      // s1's clip was cut from different words; s2 got nothing.
      s1: [clipFor('section-9', 'Something else.')],
    });
    expect(out).toEqual(shots);
  });
});
