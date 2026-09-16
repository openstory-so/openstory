import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockShare = vi.fn();

vi.doMock('@/models/server/elevenlabs-config', () => ({
  createElevenLabsSdk: vi.fn(async () => ({
    voices: { get: mockGet, share: mockShare },
  })),
}));

const { resolveAssignableVoiceId, VOICE_DESIGN_GUIDANCE_SCALE } =
  await import('./elevenlabs-voice');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Voice Design params', () => {
  it('stays in the natural band from the prompting guide', () => {
    expect(VOICE_DESIGN_GUIDANCE_SCALE).toBeGreaterThanOrEqual(15);
    expect(VOICE_DESIGN_GUIDANCE_SCALE).toBeLessThanOrEqual(40);
  });
});

describe('resolveAssignableVoiceId', () => {
  it('uses a premade voice id as-is', async () => {
    mockGet.mockResolvedValue({
      voiceId: 'premade-1',
      name: 'Rachel',
      category: 'premade',
    });
    await expect(
      resolveAssignableVoiceId('key', {
        source: 'premade',
        voiceId: 'premade-1',
      })
    ).resolves.toBe('premade-1');
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('rejects a non-premade id on the premade path', async () => {
    mockGet.mockResolvedValue({
      voiceId: 'gen-1',
      name: 'Custom',
      category: 'generated',
    });
    await expect(
      resolveAssignableVoiceId('key', { source: 'premade', voiceId: 'gen-1' })
    ).rejects.toThrow('Not a default ElevenLabs voice');
  });

  it('adds a library voice onto the account and returns the copy id', async () => {
    mockShare.mockResolvedValue({ voiceId: 'copy-1' });
    await expect(
      resolveAssignableVoiceId('key', {
        source: 'library',
        voiceId: 'lib-1',
        publicOwnerId: 'owner-1',
        name: 'Narrator · Sam',
      })
    ).resolves.toBe('copy-1');
    expect(mockShare).toHaveBeenCalledWith('owner-1', 'lib-1', {
      newName: 'Narrator · Sam',
    });
  });
});
