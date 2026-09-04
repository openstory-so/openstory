import type { Style } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { ValidationError } from '@/lib/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createLibraryTalent: vi.fn(),
  createLibraryLocation: vi.fn(),
  createSequences: vi.fn(),
  enqueueLibraryTalentSheet: vi.fn(),
  enqueueLibraryLocationSheet: vi.fn(),
  enhanceScriptToString: vi.fn(),
  uploadFile: vi.fn(async () => undefined),
}));

vi.mock('#storage', () => ({
  uploadFile: mocks.uploadFile,
  moveFile: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/script-enhancement', () => ({
  enhanceScriptToString: mocks.enhanceScriptToString,
}));

vi.mock('@/lib/sequences/create-sequences', () => ({
  createSequences: mocks.createSequences,
}));

vi.mock('@/lib/talent/create-library-talent', () => ({
  createLibraryTalent: mocks.createLibraryTalent,
}));

vi.mock('@/lib/talent/enqueue-library-talent-sheet', () => ({
  enqueueLibraryTalentSheet: mocks.enqueueLibraryTalentSheet,
}));

vi.mock('@/lib/locations/create-library-location', () => ({
  createLibraryLocation: mocks.createLibraryLocation,
  enqueueLibraryLocationSheet: mocks.enqueueLibraryLocationSheet,
}));

const { runOneShotCreate } = await import('./create');

function makeStyle(): Style {
  return {
    id: 'style-1',
    teamId: 'team-1',
    sequenceId: null,
    name: 'Cinematic Noir',
    description: null,
    config: {
      mood: 'tense',
      artStyle: 'noir',
      lighting: 'low-key',
      colorPalette: ['#000'],
      cameraWork: 'handheld',
      referenceFilms: [],
      colorGrading: 'desaturated',
    },
    category: null,
    tags: [],
    isPublic: false,
    isTemplate: false,
    version: 1,
    previewUrl: null,
    sampleVideos: [],
    recommendedImageModel: null,
    recommendedVideoModel: null,
    defaultAspectRatio: null,
    useCases: [],
    sortOrder: 100,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
  };
}

const portraitAttestation = {
  statementVersion: 'v1',
  authorizationBasis: 'self',
};

const baseInput = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  enhance: 'off' as const,
  motion: false,
  music: false,
};

function pngResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

describe('runOneShotCreate', () => {
  const talentDelete = vi.fn(async () => true);
  const locationDelete = vi.fn(async () => true);
  const callLog: string[] = [];

  const ctx = {
    user: { id: 'user-1' },
    teamId: 'team-1',
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stub covering styles.list + talent/location list/delete
    scopedDb: {
      styles: { list: async () => [makeStyle()] },
      talent: { list: async () => [], delete: talentDelete },
      locations: { list: async () => [], delete: locationDelete },
    } as unknown as ScopedDb,
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    callLog.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pngResponse())
    );

    mocks.createLibraryTalent.mockImplementation(
      async (input: { name: string; enqueueSheet?: boolean }) => {
        callLog.push(
          `createTalent:${input.name}:${String(input.enqueueSheet)}`
        );
        return {
          talent: { id: `tal-${input.name}`, name: input.name },
          sheetWorkflowRunId: null,
          deferredSheet: {
            talentId: `tal-${input.name}`,
            workflowInput: {
              userId: 'user-1',
              teamId: 'team-1',
              talentId: `tal-${input.name}`,
              talentName: input.name,
            },
            activity: 'sheet',
            deduplicationId: `dedup-${input.name}`,
          },
        };
      }
    );

    mocks.createLibraryLocation.mockImplementation(
      async (input: { name: string }) => {
        callLog.push(`createLocation:${input.name}`);
        return {
          location: { id: `loc-${input.name}`, name: input.name },
          sheetWorkflowInput: {
            userId: 'user-1',
            teamId: 'team-1',
            locationDbId: `loc-${input.name}`,
            locationName: input.name,
            referenceImageUrls: [],
            sequenceId: 'library',
          },
        };
      }
    );

    mocks.createSequences.mockImplementation(async () => {
      callLog.push('createSequences');
      return {
        entries: [
          {
            sequence: { id: 'seq-1', status: 'processing' },
            workflowRunId: 'wf-1',
          },
        ],
      };
    });

    mocks.enqueueLibraryTalentSheet.mockImplementation(async () => {
      callLog.push('enqueueTalentSheet');
      return 'sheet-run';
    });
    mocks.enqueueLibraryLocationSheet.mockImplementation(async () => {
      callLog.push('enqueueLocationSheet');
    });
  });

  it('ingests every character reference before insert and enqueues sheets only after the sequence exists', async () => {
    const result = await runOneShotCreate(
      {
        ...baseInput,
        characters: [
          {
            name: 'Ada',
            isHuman: true,
            referenceImageUrls: [
              'https://cdn.example/ada-1.png',
              'https://cdn.example/ada-2.png',
              'https://cdn.example/ada-3.png',
            ],
            portraitAttestation,
          },
          {
            name: 'Grace',
            isHuman: true,
            referenceImageUrls: [
              'https://cdn.example/grace-1.png',
              'https://cdn.example/grace-2.png',
              'https://cdn.example/grace-3.png',
            ],
            portraitAttestation,
          },
        ],
      },
      ctx
    );

    expect(result.sequences[0]?.id).toBe('seq-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    expect(mocks.createLibraryTalent).toHaveBeenCalledTimes(2);
    expect(mocks.createLibraryTalent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: 'Ada',
        enqueueSheet: false,
        referenceImageUrls: expect.arrayContaining([
          expect.stringContaining('/r2/talent/'),
        ]),
      })
    );
    expect(
      mocks.createLibraryTalent.mock.calls[0]?.[0].referenceImageUrls
    ).toHaveLength(3);

    const createIdx = callLog.indexOf('createTalent:Ada:false');
    const sequenceIdx = callLog.indexOf('createSequences');
    const enqueueIdx = callLog.indexOf('enqueueTalentSheet');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(sequenceIdx).toBeGreaterThan(createIdx);
    expect(enqueueIdx).toBeGreaterThan(sequenceIdx);
    expect(talentDelete).not.toHaveBeenCalled();
  });

  it('fails a bad reference before creating talent and names the character plus URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const url =
          input instanceof URL
            ? input.href
            : typeof input === 'string'
              ? input
              : input.url;
        if (url.includes('ada-2')) {
          return Promise.reject(
            new DOMException('The operation was aborted.', 'TimeoutError')
          );
        }
        return pngResponse();
      })
    );

    await expect(
      runOneShotCreate(
        {
          ...baseInput,
          characters: [
            {
              name: 'Ada',
              isHuman: true,
              referenceImageUrls: [
                'https://cdn.example/ada-1.png',
                'https://cdn.example/ada-2.png',
                'https://cdn.example/ada-3.png',
              ],
              portraitAttestation,
            },
          ],
        },
        ctx
      )
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ValidationError)) return false;
      expect(error.message).toContain('Character "Ada" reference image #2');
      expect(error.message).toContain('(timeout)');
      expect(error.message).toContain('https://cdn.example/ada-2.png');
      return true;
    });

    expect(mocks.createLibraryTalent).not.toHaveBeenCalled();
    expect(mocks.createSequences).not.toHaveBeenCalled();
    expect(mocks.enqueueLibraryTalentSheet).not.toHaveBeenCalled();
    expect(talentDelete).not.toHaveBeenCalled();
  });

  it('rolls back inline talents and does not enqueue sheets when sequence create fails', async () => {
    mocks.createSequences.mockImplementation(async () => {
      callLog.push('createSequences');
      throw new ValidationError(
        'Already generating this script — open the existing sequence.'
      );
    });

    await expect(
      runOneShotCreate(
        {
          ...baseInput,
          characters: [
            {
              name: 'Ada',
              isHuman: true,
              referenceImageUrls: ['https://cdn.example/ada-1.png'],
              portraitAttestation,
            },
          ],
        },
        ctx
      )
    ).rejects.toThrow(/Already generating this script/);

    expect(mocks.createLibraryTalent).toHaveBeenCalledTimes(1);
    expect(talentDelete).toHaveBeenCalledWith('tal-Ada');
    expect(mocks.enqueueLibraryTalentSheet).not.toHaveBeenCalled();
  });
});
