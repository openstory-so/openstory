/**
 * Slot-leak invariants for ElevenLabs voice release (#1553): provider delete
 * before the row write, and the caller's own row never counts as "someone
 * else still needs it".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';

const mockDelete = vi.fn();
const mockGetKey = vi.fn();
const mockConfigured = vi.fn();

vi.doMock('@/cast/server/voice/elevenlabs-voice', async () => ({
  ...(await vi.importActual<
    typeof import('@/cast/server/voice/elevenlabs-voice')
  >('@/cast/server/voice/elevenlabs-voice')),
  deleteElevenLabsVoice: mockDelete,
}));
vi.doMock('@/models/server/elevenlabs-config', () => ({
  getElevenLabsApiKey: mockGetKey,
  isElevenLabsConfigured: mockConfigured,
}));

const { releaseCharacterVoice, releaseVoiceIfUnreferenced } =
  await import('./release-voice');

function makeScopedDb(referenceCount: number) {
  const update = vi.fn(async () => ({}));
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface release touches
  const scopedDb = {
    characters: {
      getVoiceReferenceCount: vi.fn(async () => referenceCount),
      update,
    },
  } as unknown as ScopedDb;
  return { scopedDb, update };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetKey.mockReturnValue('key');
  mockConfigured.mockReturnValue(true);
  mockDelete.mockResolvedValue(undefined);
});

describe('releaseVoiceIfUnreferenced', () => {
  it('deletes when no row points at the voice', async () => {
    const { scopedDb } = makeScopedDb(0);
    await releaseVoiceIfUnreferenced(scopedDb, 'v1');
    expect(mockDelete).toHaveBeenCalledWith('key', 'v1');
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
});

describe('releaseCharacterVoice', () => {
  it('frees the slot, then nulls the pointer', async () => {
    const { scopedDb, update } = makeScopedDb(1);
    await releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: 'v1' });
    expect(mockDelete).toHaveBeenCalledWith('key', 'v1');
    expect(update).toHaveBeenCalledWith('c1', { voiceId: null });
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0] ?? 0
    );
  });
  it('leaves the pointer on the row when the provider delete fails', async () => {
    mockDelete.mockRejectedValue(new Error('502'));
    const { scopedDb, update } = makeScopedDb(1);
    await expect(
      releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: 'v1' })
    ).rejects.toThrow('502');
    expect(update).not.toHaveBeenCalled();
  });
  it('nulls nothing and deletes nothing for a row without a voice', async () => {
    const { scopedDb, update } = makeScopedDb(0);
    await releaseCharacterVoice(scopedDb, { id: 'c1', voiceId: null });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
