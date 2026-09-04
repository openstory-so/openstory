import { describe, expect, test } from 'vitest';
import { loneFailedPrimaryJobIndex } from './shot-images-workflow';

const ok = { status: 'fulfilled' as const, value: 'https://cdn.example/a.png' };
const fail = { status: 'rejected' as const, reason: new Error('content flag') };

describe('loneFailedPrimaryJobIndex', () => {
  test('returns the lone failed primary so the parent can retry it once', () => {
    const jobs = [
      { model: 'gpt_image_2' },
      { model: 'gpt_image_2' },
      { model: 'gpt_image_2' },
    ];
    const results = [ok, fail, ok];
    expect(loneFailedPrimaryJobIndex(jobs, results, 'gpt_image_2')).toBe(1);
  });

  test('does not retry when every primary succeeded', () => {
    const jobs = [{ model: 'gpt_image_2' }, { model: 'gpt_image_2' }];
    expect(loneFailedPrimaryJobIndex(jobs, [ok, ok], 'gpt_image_2')).toBeNull();
  });

  test('does not retry when more than one primary failed', () => {
    const jobs = [
      { model: 'gpt_image_2' },
      { model: 'gpt_image_2' },
      { model: 'gpt_image_2' },
    ];
    expect(
      loneFailedPrimaryJobIndex(jobs, [fail, ok, fail], 'gpt_image_2')
    ).toBeNull();
  });

  test('ignores alternate-model failures — only the primary is retried', () => {
    const jobs = [
      { model: 'gpt_image_2' },
      { model: 'nano_banana_2' },
      { model: 'gpt_image_2' },
    ];
    // Scene 0 primary ok, its alternate failed; scene 1 primary failed.
    expect(
      loneFailedPrimaryJobIndex(jobs, [ok, fail, fail], 'gpt_image_2')
    ).toBe(2);
  });
});
