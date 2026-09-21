import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockShare = vi.fn();
const mockDelete = vi.fn();

vi.doMock('@/models/server/elevenlabs-config', () => ({
  createElevenLabsSdk: vi.fn(async () => ({
    voices: { get: mockGet, share: mockShare, delete: mockDelete },
  })),
}));

const {
  deleteElevenLabsVoice,
  getElevenLabsVoice,
  isElevenLabsVoiceMissing,
  resolveAssignableVoiceId,
  VOICE_DESIGN_GUIDANCE_SCALE,
} = await import('./elevenlabs-voice');

/** ElevenLabs GET/DELETE of a gone voice: 400 + voice_not_found, not 404. */
const voiceNotFound = (voiceId: string) => ({
  statusCode: 400,
  body: {
    detail: {
      type: 'not_found',
      code: 'voice_not_found',
      message: `A voice with ID '${voiceId}' was not found.`,
      status: 'voice_not_found',
    },
  },
});

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

describe('isElevenLabsVoiceMissing', () => {
  it('treats 404 and 400 voice_not_found as gone', () => {
    expect(isElevenLabsVoiceMissing({ statusCode: 404 })).toBe(true);
    expect(isElevenLabsVoiceMissing(voiceNotFound('abc'))).toBe(true);
  });
  it('does not swallow other 400s', () => {
    expect(
      isElevenLabsVoiceMissing({
        statusCode: 400,
        body: { detail: { code: 'voice_limit_exceeded', message: 'Full' } },
      })
    ).toBe(false);
  });
});

describe('getElevenLabsVoice', () => {
  it('returns null when ElevenLabs says the voice is gone (#1709)', async () => {
    mockGet.mockRejectedValue(voiceNotFound('N3X0YWvzne19q1776q24'));
    await expect(
      getElevenLabsVoice('key', 'N3X0YWvzne19q1776q24')
    ).resolves.toBe(null);
  });
  it('returns null on 404', async () => {
    mockGet.mockRejectedValue({ statusCode: 404 });
    await expect(getElevenLabsVoice('key', 'gone')).resolves.toBe(null);
  });
  it('throws other 400s', async () => {
    mockGet.mockRejectedValue({
      statusCode: 400,
      body: { detail: { code: 'voice_limit_exceeded', message: 'Full' } },
    });
    await expect(getElevenLabsVoice('key', 'x')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('deleteElevenLabsVoice', () => {
  it('is a no-op when ElevenLabs says the voice is already gone', async () => {
    mockDelete.mockRejectedValue(voiceNotFound('abc'));
    await expect(deleteElevenLabsVoice('key', 'abc')).resolves.toBeUndefined();
  });
});
