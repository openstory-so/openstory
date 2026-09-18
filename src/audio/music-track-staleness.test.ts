import { describe, expect, it } from 'vitest';
import { computeSequenceMusicInputHash } from '@/shots/input-hash';
import {
  musicRequestDurationSeconds,
  musicTrackStaleness,
} from './music-track-staleness';

const base = {
  prompt: 'warm analogue synth pad, slow build',
  tags: 'ambient, synth, instrumental',
  requestDurationSeconds: 45,
  audioModel: 'elevenlabs_music',
};

/** The digest `MusicWorkflow` stamps for {@link base}. */
const storedFor = (
  overrides: Partial<{ prompt: string; tags: string; durationSeconds: number }>
) =>
  computeSequenceMusicInputHash({
    prompt: base.prompt,
    tags: base.tags,
    durationSeconds: base.requestDurationSeconds,
    audioModel: base.audioModel,
    ...overrides,
  });

describe('musicRequestDurationSeconds', () => {
  it('sums shot durations, 10s when unset, 30s floor when empty', async () => {
    expect(
      musicRequestDurationSeconds([
        { durationMs: 5000 },
        { durationMs: null },
        { durationMs: 2500 },
      ])
    ).toBe(18);
    expect(musicRequestDurationSeconds([])).toBe(30);
  });
});

describe('musicTrackStaleness', () => {
  it('is fresh while prompt, tags, duration and model all match', async () => {
    expect(
      await musicTrackStaleness({
        ...base,
        storedInputHash: await storedFor({}),
      })
    ).toBe('fresh');
  });

  it('is stale when the music prompt was edited or regenerated', async () => {
    expect(
      await musicTrackStaleness({
        ...base,
        prompt: 'driving percussion, urgent',
        storedInputHash: await storedFor({}),
      })
    ).toBe('stale');
  });

  it('is stale when the tags moved', async () => {
    expect(
      await musicTrackStaleness({
        ...base,
        tags: 'orchestral, strings',
        storedInputHash: await storedFor({}),
      })
    ).toBe('stale');
  });

  it('is stale when the shot durations moved', async () => {
    expect(
      await musicTrackStaleness({
        ...base,
        requestDurationSeconds: 70,
        storedInputHash: await storedFor({}),
      })
    ).toBe('stale');
  });

  it('clamps the request to the model ceiling, as the generation did', async () => {
    // ace_step tops out at 240s: a 300s sequence hashes as 240, so a track
    // rendered at the ceiling does not read stale for ever.
    expect(
      await musicTrackStaleness({
        ...base,
        audioModel: 'ace_step',
        requestDurationSeconds: 300,
        storedInputHash: await computeSequenceMusicInputHash({
          prompt: base.prompt,
          tags: base.tags,
          durationSeconds: 240,
          audioModel: 'ace_step',
        }),
      })
    ).toBe('fresh');
  });

  it('is untracked with no stored hash — an upload is never stale', async () => {
    expect(await musicTrackStaleness({ ...base, storedInputHash: null })).toBe(
      'untracked'
    );
  });

  it('is untracked for a non-catalog model such as user-upload', async () => {
    expect(
      await musicTrackStaleness({
        ...base,
        audioModel: 'user-upload',
        storedInputHash: await storedFor({}),
      })
    ).toBe('untracked');
  });

  it('is untracked when the sequence has no prompt or tags to compare', async () => {
    const storedInputHash = await storedFor({});
    expect(
      await musicTrackStaleness({ ...base, prompt: null, storedInputHash })
    ).toBe('untracked');
    expect(
      await musicTrackStaleness({ ...base, tags: null, storedInputHash })
    ).toBe('untracked');
  });
});
