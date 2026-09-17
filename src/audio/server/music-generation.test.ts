import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as tanstackAi from '@tanstack/ai';
import {
  ELEVENLABS_MUSIC_ENDPOINT,
  ELEVENLABS_MUSIC_MODEL,
} from '@/billing/elevenlabs-pricing';

const generateAudio = vi.fn();
const uploadFile = vi.fn();
const createElevenLabsAudio = vi.fn(
  (_model: string, _apiKey: string, _config?: unknown) => ({
    name: 'elevenlabs',
  })
);
const env: Record<string, string | undefined> = {};

vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  generateAudio,
}));

vi.doMock('#storage', () => ({
  uploadFile,
}));

vi.doMock('#env', () => ({ getEnv: () => env }));

vi.doMock('@/models/server/elevenlabs-config', async () => {
  const real = await vi.importActual<
    typeof import('@/models/server/elevenlabs-config')
  >('@/models/server/elevenlabs-config');
  return {
    ...real,
    loadElevenLabsAudio: async () => createElevenLabsAudio,
  };
});

vi.doMock('@/platform/server/observability/ai-otel', () => ({
  recordMediaGenerationSpan: vi.fn(),
}));

const { generateMusic } = await import('./music-generation');

describe('generateMusic native ElevenLabs', () => {
  beforeEach(() => {
    generateAudio.mockReset();
    uploadFile.mockReset();
    createElevenLabsAudio.mockClear();
    env.ELEVENLABS_API_KEY = 'el-test';
    env.ELEVENLABS_BASE_URL = undefined;
    env.E2E_TEST = undefined;
  });

  it('refuses the native path when no platform key is configured', async () => {
    env.ELEVENLABS_API_KEY = undefined;
    await expect(
      generateMusic({ prompt: 'lo-fi beat', duration: 30 })
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(generateAudio).not.toHaveBeenCalled();
  });

  it('parks adapter bytes in R2 and bills minutes rounded up', async () => {
    generateAudio.mockResolvedValue({
      id: 'el-req-1',
      audio: { b64Json: Buffer.from('fake-mp3').toString('base64') },
    });
    uploadFile.mockResolvedValue({
      publicUrl: 'https://cdn.example/music.mp3',
      path: 'audio/team/seq/music/x.mp3',
      fullPath: 'audio/team/seq/music/x.mp3',
    });

    const result = await generateMusic({
      prompt: 'lo-fi beat',
      duration: 61,
      teamId: 'team_1',
      sequenceId: 'seq_1',
      scopedDb: {
        userId: 'user_1',
        resolveKey: async () => ({ key: 'el-test', source: 'platform' }),
        resolveOptionalKey: async () => ({
          key: 'el-test',
          source: 'platform' as const,
        }),
      },
    });

    expect(createElevenLabsAudio).toHaveBeenCalledWith(
      ELEVENLABS_MUSIC_MODEL,
      'el-test',
      expect.objectContaining({ timeoutInSeconds: 600 })
    );
    expect(generateAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'lo-fi beat',
        duration: 61,
        modelOptions: { forceInstrumental: true },
      })
    );
    expect(uploadFile).toHaveBeenCalled();
    expect(result.audioUrl).toBe('https://cdn.example/music.mp3');
    expect(result.storagePath).toMatch(/^team_1\/seq_1\/music\/.+\.mp3$/);
    expect(result.metadata.endpointId).toBe(ELEVENLABS_MUSIC_ENDPOINT);
    expect(result.metadata.unitsBilled).toBe(2);
    expect(result.metadata.cost).toBe(300_000);
    expect(result.metadata.usedOwnKey).toBe(false);
  });
});
