import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_MODEL,
  type ImageToVideoModel,
} from '@/shared/ai/models';
import { buildMotionJobs } from './motion-batch-jobs';

type Shot = { shotId: string; model?: ImageToVideoModel };

const A: ImageToVideoModel = 'kling_v3_pro';
const B: ImageToVideoModel = 'veo3_1';

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
});
