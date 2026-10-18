import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ValidationError } from '@/platform/errors';
import { asStub } from '@/test/as-stub';

const mockUpload = vi.fn();
const mockAnalyzeClip = vi.fn();
vi.doMock('@/models/server/gemini-files', () => ({
  uploadClipToGemini: mockUpload,
  deleteGeminiFile: vi.fn(),
}));
vi.doMock('@/cast/server/talent-vision', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzeTalentClip: mockAnalyzeClip,
}));

const { analyzeTalentClipForTeam } = await import('./analyze-talent-media');

describe('analyzeTalentClipForTeam', () => {
  it('refuses a key that is not native Google before the clip leaves storage (#1930)', async () => {
    const scopedDb = asStub<ScopedDb>({
      apiKeys: {
        resolveLlmKey: async () => ({
          key: 'k',
          via: 'openrouter',
          source: 'platform',
        }),
      },
    });

    await expect(
      analyzeTalentClipForTeam({
        scopedDb,
        userId: 'u',
        key: 'talent/t/uploads/clip.mp4',
        mimeType: 'video/mp4',
        idempotencyKey: 'likeness:x',
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAnalyzeClip).not.toHaveBeenCalled();
  });
});
