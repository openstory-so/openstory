import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatingSequence } from './creating-sequence';

const mem = new Map<string, string>();
const sessionStorageMock = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

const INPUT: Omit<CreatingSequence, 'parkedAt'> = {
  payload: {
    teamId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    script: 'INT. LAUNDROMAT - NIGHT. A courier waits.',
    styleId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    aspectRatio: '9:16',
    analysisModels: ['openai/gpt-5.6-luna'],
    imageModels: ['nano_banana_2_lite'],
    videoModel: 'minimax_h3_max',
    videoModels: ['minimax_h3_max'],
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    generateStartFrames: false,
    stopAt: 'script',
  },
  script: 'INT. LAUNDROMAT - NIGHT. A courier waits.',
  stopAt: 'script',
  generateStartFrames: false,
};

describe('creating sequence park', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { sessionStorage: sessionStorageMock });
    vi.stubGlobal('sessionStorage', sessionStorageMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parks, peeks, claims once, then clears', async () => {
    const {
      parkCreatingSequence,
      peekCreatingSequence,
      claimCreatingSequenceStart,
      clearCreatingSequence,
    } = await import('./creating-sequence');

    clearCreatingSequence();
    expect(peekCreatingSequence()).toBeNull();

    parkCreatingSequence(INPUT);
    const parked = peekCreatingSequence();
    expect(parked?.script).toBe(INPUT.script);
    expect(parked?.stopAt).toBe('script');

    expect(claimCreatingSequenceStart()).toBe(true);
    expect(claimCreatingSequenceStart()).toBe(false);

    clearCreatingSequence();
    expect(peekCreatingSequence()).toBeNull();
    expect(claimCreatingSequenceStart()).toBe(true);
  });

  it('expires a stale park', async () => {
    const {
      parkCreatingSequence,
      peekCreatingSequence,
      clearCreatingSequence,
    } = await import('./creating-sequence');

    clearCreatingSequence();
    parkCreatingSequence(INPUT);
    vi.setSystemTime(new Date('2026-09-13T12:11:00Z'));
    expect(peekCreatingSequence()).toBeNull();
  });
});
