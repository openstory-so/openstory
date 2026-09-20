/**
 * Slot-leak invariants for ElevenLabs voice release (#1553): provider delete
 * before the row write, and the caller's own row never counts as "someone
 * else still needs it".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';

const mockDelete = vi.fn();
const mockGetVoice = vi.fn();
const mockGetKey = vi.fn();
const mockConfigured = vi.fn();

vi.doMock('@/cast/server/voice/elevenlabs-voice', async () => ({
  ...(await vi.importActual<
    typeof import('@/cast/server/voice/elevenlabs-voice')
  >('@/cast/server/voice/elevenlabs-voice')),
  deleteElevenLabsVoice: mockDelete,
  getElevenLabsVoice: mockGetVoice,
}));
vi.doMock('@/models/server/elevenlabs-config', () => ({
  getElevenLabsApiKey: mockGetKey,
  isElevenLabsConfigured: mockConfigured,
}));

const {
  releaseCharacterVoice,
  releaseReplacedVoice,
  releaseVoiceIfUnreferenced,
} = await import('./release-voice');

function makeScopedDb(referenceCount: number) {
  const updateVoice = vi.fn(async () => ({}));
  const markVoiceReleased = vi.fn(async () => undefined);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface release touches
  const scopedDb = {
    characters: {
      getVoiceReferenceCount: vi.fn(async () => referenceCount),
      markVoiceReleased,
      updateVoice,
    },
  } as unknown as ScopedDb;
  return { scopedDb, updateVoice, markVoiceReleased };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetKey.mockReturnValue('key');
  mockConfigured.mockReturnValue(true);
  mockDelete.mockResolvedValue(undefined);
  mockGetVoice.mockResolvedValue({
    voiceId: 'v1',
    name: 'Designed',
    category: 'generated',
    previewUrl: null,
    isPremade: false,
  });
});

describe('releaseReplacedVoice', () => {
  it('does not throw when the release fails — the switch already committed', async () => {
    mockDelete.mockRejectedValue(new Error('ElevenLabs 503'));
    const { scopedDb } = makeScopedDb(0);
    await expect(
      releaseReplacedVoice(scopedDb, 'v1', 'v2')
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith('key', 'v1');
  });
  it('releases nothing when the voice did not change or there was none', async () => {
    const { scopedDb } = makeScopedDb(0);
    await releaseReplacedVoice(scopedDb, 'v1', 'v1');
    await releaseReplacedVoice(scopedDb, null, 'v2');
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('releaseVoiceIfUnreferenced', () => {
  it('deletes when no row points at the voice, then marks the history rows released', async () => {
    const { scopedDb, markVoiceReleased } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).toHaveBeenCalledWith('key', 'v1');
    // #1657: the id is gone, so no version row may offer it back.
    expect(markVoiceReleased).toHaveBeenCalledWith('v1');
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(
      markVoiceReleased.mock.invocationCallOrder[0] ?? 0
    );
  });
  it('marks a voice already gone at the provider released, without a delete', async () => {
    // A retry after a failed row write, or a dashboard delete: the id is dead
    // either way, so History must not offer it back.
    mockGetVoice.mockResolvedValue(null);
    const { scopedDb, markVoiceReleased } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).not.toHaveBeenCalled();
    expect(markVoiceReleased).toHaveBeenCalledWith('v1');
  });
  it('marks nothing released when the provider keeps the voice', async () => {
    const { scopedDb, markVoiceReleased } = makeScopedDb(1);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(markVoiceReleased).not.toHaveBeenCalled();
  });
  it('keeps the voice while another row still holds it', async () => {
    const { scopedDb } = makeScopedDb(1);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it("ignores the caller's own row via heldBy", async () => {
    const { scopedDb } = makeScopedDb(1);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1', { heldBy: 1 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
  it('warns and moves on when the key is rejected — a retry cannot help', async () => {
    mockDelete.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { statusCode: 401 })
    );
    const { scopedDb } = makeScopedDb(0);
    await expect(releaseVoiceIfUnreferenced(scopedDb, 'v1')).resolves.toBe(
      undefined
    );
  });
  it('skips the provider when ElevenLabs is not configured', async () => {
    mockConfigured.mockReturnValue(false);
    const { scopedDb } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it('does not delete a premade default voice', async () => {
    mockGetVoice.mockResolvedValue({
      voiceId: 'v1',
      name: 'Rachel',
      category: 'premade',
      previewUrl: null,
      isPremade: true,
    });
    const { scopedDb } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it('skips delete when the voice is already gone', async () => {
    mockGetVoice.mockResolvedValue(null);
    const { scopedDb } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('releaseCharacterVoice', () => {
  it('frees the slot, then nulls the pointer as a released version', async () => {
    const { scopedDb, updateVoice } = makeScopedDb(1);
    await releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: 'v1' });
    expect(mockDelete).toHaveBeenCalledWith('key', 'v1');
    expect(updateVoice).toHaveBeenCalledWith(
      'c1',
      { voiceId: null },
      'removed'
    );
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(
      updateVoice.mock.invocationCallOrder[0] ?? 0
    );
  });
  it('leaves the pointer on the row when the provider delete fails', async () => {
    mockDelete.mockRejectedValue(new Error('502'));
    const { scopedDb, updateVoice } = makeScopedDb(1);
    await expect(
      releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: 'v1' })
    ).rejects.toThrow('502');
    expect(updateVoice).not.toHaveBeenCalled();
  });
  it('nulls nothing and deletes nothing for a row without a voice', async () => {
    const { scopedDb, updateVoice } = makeScopedDb(0);
    await releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: null });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateVoice).not.toHaveBeenCalled();
  });
});
