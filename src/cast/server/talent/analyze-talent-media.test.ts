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

const { analyzeTalentClipForTeam, sheetMetadataFromAnalysis } =
  await import('./analyze-talent-media');

describe('sheetMetadataFromAnalysis', () => {
  it('maps vision fields onto a character bible entry', () => {
    const metadata = sheetMetadataFromAnalysis('Mara Quinn', {
      isCharacterSheet: true,
      subjectKind: 'human',
      suggestedName: 'Mara',
      description: 'A woman in a leather jacket.',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'Sharp bob',
      standardClothing: 'Leather jacket',
      distinguishingFeatures: 'Hoop earring',
    });
    expect(metadata).toMatchObject({
      characterId: 'mara_quinn',
      name: 'Mara Quinn',
      age: '30s',
      physicalDescription: 'Sharp bob',
      standardClothing: 'Leather jacket',
      consistencyTag: 'mara_quinn',
    });
  });

  it('falls back to the long description when physicalDescription is blank', () => {
    const metadata = sheetMetadataFromAnalysis('Sam', {
      isCharacterSheet: false,
      subjectKind: 'human',
      suggestedName: '',
      description: 'A ranch hand with sunburnt skin.',
      age: '',
      gender: '',
      ethnicity: '',
      physicalDescription: '  ',
      standardClothing: '',
      distinguishingFeatures: '',
    });
    expect(metadata.physicalDescription).toBe(
      'A ranch hand with sunburnt skin.'
    );
  });
});

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
