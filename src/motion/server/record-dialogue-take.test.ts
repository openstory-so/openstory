import { describe, expect, it } from 'vitest';
import {
  DIALOGUE_TAKE_CHUNK_CHARS,
  chunkTakeLines,
  shotSliceWindows,
} from './record-dialogue-take';
import type { DialogueTakeSegment } from '@/platform/server/db/schema';

const turn = (shotId: string, text: string, tone = '') => ({
  shotId,
  text,
  tone,
});

describe('chunkTakeLines', () => {
  it('keeps a whole scene in one call while it fits', () => {
    const lines = [turn('a', 'One'), turn('b', 'Two'), turn('a', 'Three')];
    expect(chunkTakeLines(lines)).toEqual([lines]);
  });

  it('breaks at a shot boundary, never inside a shot', () => {
    const long = 'x'.repeat(700);
    const lines = [
      turn('a', long),
      turn('a', long),
      turn('b', long),
      turn('b', long),
    ];
    const chunks = chunkTakeLines(lines, 1500);
    expect(chunks.map((chunk) => chunk.map((line) => line.shotId))).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  it('keeps a single shot together even when it alone is over the limit', () => {
    const lines = [turn('a', 'x'.repeat(3000)), turn('b', 'short')];
    const chunks = chunkTakeLines(lines, DIALOGUE_TAKE_CHUNK_CHARS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.map((line) => line.shotId)).toEqual(['a']);
  });

  it('counts the tone tag, which is text the provider speaks against', () => {
    const lines = [turn('a', 'x'.repeat(40), 'whispered urgent')];
    // "[whispered urgent] " + 40 characters is over 50, so this chunks alone.
    expect(chunkTakeLines([...lines, turn('b', 'y')], 50)).toHaveLength(2);
  });

  it('returns nothing for no turns', () => {
    expect(chunkTakeLines([])).toEqual([]);
  });
});

describe('shotSliceWindows', () => {
  const segment = (
    shotId: string,
    startSeconds: number,
    endSeconds: number,
    lineIndex = 0
  ): DialogueTakeSegment => ({ shotId, startSeconds, endSeconds, lineIndex });

  it('gives the gap between turns to the shot about to speak', () => {
    const windows = shotSliceWindows(
      [segment('a', 0.2, 2), segment('b', 3, 5, 1)],
      6
    );
    expect(windows).toEqual([
      { shotId: 'a', from: 0, to: 3, speechEnd: 2 },
      { shotId: 'b', from: 2, to: 6, speechEnd: 5 },
    ]);
  });

  it('runs the last shot to the end of the take', () => {
    const windows = shotSliceWindows([segment('only', 0.5, 4)], 9);
    expect(windows[0]).toEqual({
      shotId: 'only',
      from: 0,
      to: 9,
      speechEnd: 4,
    });
  });

  it('spans every turn a shot speaks', () => {
    const windows = shotSliceWindows(
      [segment('a', 0, 1), segment('a', 2, 3, 1), segment('b', 4, 5, 2)],
      6
    );
    expect(windows[0]).toEqual({ shotId: 'a', from: 0, to: 4, speechEnd: 3 });
  });

  it('orders the windows by who speaks first', () => {
    const windows = shotSliceWindows(
      [segment('b', 0, 1), segment('a', 2, 3, 1)],
      4
    );
    expect(windows.map((window) => window.shotId)).toEqual(['b', 'a']);
  });

  it('never cuts a shot short of its own last word', () => {
    // An interleaved scene: shot b speaks between shot a's two turns.
    const windows = shotSliceWindows(
      [segment('a', 0, 1), segment('b', 2, 3, 1), segment('a', 4, 5, 2)],
      6
    );
    const first = windows[0];
    expect(first?.shotId).toBe('a');
    expect(first?.speechEnd).toBe(5);
    expect(first?.to).toBeGreaterThanOrEqual(5);
  });
});
