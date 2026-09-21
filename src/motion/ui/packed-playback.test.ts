import { describe, expect, it } from 'vitest';
import { packedClipWindows } from '@/shots/packed-clip-window';
import { createPackedPlayback } from './packed-playback';

const windows = packedClipWindows([
  { id: 'a', shotNumber: 1, durationMs: 3000 },
  { id: 'b', shotNumber: 2, durationMs: 3000 },
]);

describe('packed playback navigation', () => {
  it('does not seek back while playback-driven navigation is awaiting the router', () => {
    const playback = createPackedPlayback();
    playback.select('clip', 'a', windows);
    playback.timeUpdate('clip', 0);
    expect(playback.timeUpdate('clip', 3.1)).toBe('b');
    // React can render with the old search params before navigation commits.
    expect(playback.select('clip', 'a', windows)).toBeNull();
    expect(playback.timeUpdate('clip', 3.2)).toBeUndefined();
    expect(playback.select('clip', 'b', windows)).toBeNull();
  });

  it('does not navigate back to the old shot while a manual seek is pending', () => {
    const playback = createPackedPlayback();
    playback.select('clip', 'a', windows);
    playback.timeUpdate('clip', 1);
    expect(playback.select('clip', 'b', windows)).toBe(3);
    expect(playback.timeUpdate('clip', 1.1)).toBeUndefined();
    expect(playback.timeUpdate('clip', 3)).toBeUndefined();
    expect(playback.select('clip', 'b', windows)).toBeNull();
  });
  it('seeks back on a manual backward selection, then lets playback advance again', () => {
    const playback = createPackedPlayback();
    expect(playback.select('clip', 'b', windows)).toBe(3);
    playback.timeUpdate('clip', 4);
    expect(playback.select('clip', 'a', windows)).toBe(0);
    expect(playback.timeUpdate('clip', 4.1)).toBeUndefined();
    expect(playback.timeUpdate('clip', 0)).toBeUndefined();
    expect(playback.timeUpdate('clip', 3.1)).toBe('b');
    expect(playback.select('clip', 'b', windows)).toBeNull();
  });

  it('ignores events from a replaced clip and seeks into the newly selected clip', () => {
    const playback = createPackedPlayback();
    playback.select('old', 'a', windows);
    playback.timeUpdate('old', 1);
    expect(playback.select('new', 'b', windows)).toBe(3);
    expect(playback.timeUpdate('old', 1.1)).toBeUndefined();
    expect(playback.timeUpdate('new', 0)).toBeUndefined();
    expect(playback.timeUpdate('new', 3)).toBeUndefined();
  });

  it('does not rewind the last shot when the clip ends', () => {
    const playback = createPackedPlayback();
    playback.select('clip', 'b', windows);
    playback.timeUpdate('clip', 3);
    expect(playback.timeUpdate('clip', 6)).toBeUndefined();
    expect(playback.select('clip', 'b', windows)).toBeNull();
  });

  it('handles multiple chapter crossings before the router commits', () => {
    const three = packedClipWindows([
      { id: 'a', shotNumber: 1, durationMs: 1000 },
      { id: 'b', shotNumber: 2, durationMs: 1000 },
      { id: 'c', shotNumber: 3, durationMs: 1000 },
    ]);
    const playback = createPackedPlayback();
    playback.select('clip', 'a', three);
    playback.timeUpdate('clip', 0);
    expect(playback.timeUpdate('clip', 1.1)).toBe('b');
    expect(playback.timeUpdate('clip', 2.1)).toBe('c');
    expect(playback.select('clip', 'b', three)).toBeNull();
    expect(playback.timeUpdate('clip', 2.2)).toBeUndefined();
    expect(playback.select('clip', 'c', three)).toBeNull();
  });

  it('allows revisiting a chapter whose intermediate navigation was superseded', () => {
    const three = packedClipWindows([
      { id: 'a', shotNumber: 1, durationMs: 1000 },
      { id: 'b', shotNumber: 2, durationMs: 1000 },
      { id: 'c', shotNumber: 3, durationMs: 1000 },
    ]);
    const playback = createPackedPlayback();
    playback.select('clip', 'a', three);
    playback.timeUpdate('clip', 0);
    playback.timeUpdate('clip', 1.1);
    playback.timeUpdate('clip', 2.1);
    // The router only commits its newest destination.
    playback.select('clip', 'c', three);
    expect(playback.timeUpdate('clip', 1.5)).toBe('b');
    expect(playback.select('clip', 'b', three)).toBeNull();
  });

  it('does not seek or change selection for an unpacked shot', () => {
    const playback = createPackedPlayback();
    expect(playback.select('clip', 'a', [])).toBeNull();
    expect(playback.timeUpdate('clip', 1)).toBeUndefined();
  });
});
