import { describe, expect, it } from 'vitest';
import { pinMovesFromEvents, pinnedVersionAt } from './pin-moves';

const t = (n: number) => new Date(n);

describe('pinMovesFromEvents', () => {
  it('reads bible and look moves off the events that moved a pin', () => {
    const { bible, look } = pinMovesFromEvents([
      {
        kind: 'character.updated',
        targetId: 'c1',
        createdAt: t(10),
        data: {
          prevState: { age: null },
          bibleVersion: { from: 'b1', to: 'b2' },
        },
      },
      // A voice-description-only edit appended no version: not a move.
      {
        kind: 'character.updated',
        targetId: 'c1',
        createdAt: t(11),
        data: { prevState: { voiceDescription: 'x' }, bibleVersion: null },
      },
      {
        kind: 'look.updated',
        targetId: 'c1',
        createdAt: t(12),
        data: { lookId: 'l1', lookVersion: { from: 'v1', to: 'v2' } },
      },
      {
        kind: 'character.version-moved',
        targetId: 'c1',
        createdAt: t(20),
        data: {
          bible: { from: 'b2', to: 'b3' },
          looks: [{ lookId: 'l1', from: 'v2', to: 'v3' }],
        },
      },
    ]);
    expect(bible.get('c1')).toEqual([
      { at: t(10), from: 'b1', to: 'b2' },
      { at: t(20), from: 'b2', to: 'b3' },
    ]);
    expect(look.get('l1')).toEqual([
      { at: t(12), from: 'v1', to: 'v2' },
      { at: t(20), from: 'v2', to: 'v3' },
    ]);
  });

  it('keeps a pre-#2017 bible edit as a move from nowhere, and skips a voice-only one', () => {
    const { bible } = pinMovesFromEvents([
      {
        kind: 'character.updated',
        targetId: 'c1',
        createdAt: t(10),
        data: { prevState: { age: '30s' } },
      },
      {
        kind: 'character.updated',
        targetId: 'c1',
        createdAt: t(11),
        data: { prevState: { voiceDescription: 'x' } },
      },
    ]);
    expect(bible.get('c1')).toEqual([{ at: t(10), from: null, to: '' }]);
  });
});

describe('pinnedVersionAt', () => {
  const moves = [
    { at: t(10), from: 'b1', to: 'b2' },
    { at: t(20), from: 'b2', to: 'b3' },
  ];
  it('is the pin now when nothing moved since', () => {
    expect(pinnedVersionAt('b3', moves, 25)).toBe('b3');
    expect(pinnedVersionAt('b3', undefined, 5)).toBe('b3');
  });
  it('walks back through every move made since', () => {
    expect(pinnedVersionAt('b3', moves, 15)).toBe('b2');
    expect(pinnedVersionAt('b3', moves, 5)).toBe('b1');
  });
  it('is unknown past a move that did not record where it came from', () => {
    expect(
      pinnedVersionAt('b3', [{ at: t(10), from: null, to: '' }, ...moves], 5)
    ).toBeNull();
    // Another sequence's edit is not in this sequence's moves: the pin at
    // that time is exactly what this sequence held, not the newest version.
    expect(pinnedVersionAt('b1', [], 5)).toBe('b1');
  });
});
