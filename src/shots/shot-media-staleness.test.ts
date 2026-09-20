import { describe, expect, it } from 'vitest';
import {
  dialogueArtifactStaleness,
  videoArtifactStaleness,
} from './shot-media-staleness';

describe('dialogueArtifactStaleness (#1703)', () => {
  it('is untracked when the shot never had dialogue audio', () => {
    expect(
      dialogueArtifactStaleness({
        voiced: true,
        hasAudio: false,
        matching: false,
      })
    ).toBe('untracked');
  });

  it('is untracked when the shot has nothing to say', () => {
    expect(
      dialogueArtifactStaleness({
        voiced: false,
        hasAudio: true,
        matching: false,
      })
    ).toBe('untracked');
  });

  it('is stale when existing audio no longer matches the current reading', () => {
    expect(
      dialogueArtifactStaleness({
        voiced: true,
        hasAudio: true,
        matching: false,
      })
    ).toBe('stale');
  });

  it('is fresh when the current clips still match', () => {
    expect(
      dialogueArtifactStaleness({
        voiced: true,
        hasAudio: true,
        matching: true,
      })
    ).toBe('fresh');
  });

  it('is updating when a recording is already in flight', () => {
    expect(
      dialogueArtifactStaleness({
        voiced: true,
        hasAudio: true,
        matching: false,
        generating: true,
      })
    ).toBe('updating');
  });
});

describe('videoArtifactStaleness (#1703)', () => {
  it('is untracked when the shot has no video yet', () => {
    expect(
      videoArtifactStaleness({
        hasVideo: false,
        alreadyStale: false,
        generating: false,
      })
    ).toBe('untracked');
  });

  it('is stale when the selected clip’s manifest diverged', () => {
    expect(
      videoArtifactStaleness({
        hasVideo: true,
        alreadyStale: true,
        generating: false,
      })
    ).toBe('stale');
  });

  it('is updating while a render is in flight', () => {
    expect(
      videoArtifactStaleness({
        hasVideo: true,
        alreadyStale: true,
        generating: true,
      })
    ).toBe('updating');
  });

  it('is fresh when the selected clip still matches', () => {
    expect(
      videoArtifactStaleness({
        hasVideo: true,
        alreadyStale: false,
        generating: false,
      })
    ).toBe('fresh');
  });
});
