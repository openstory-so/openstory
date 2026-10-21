import type { Style } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ValidationError } from '@/platform/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asStub } from '@/test/as-stub';

const mocks = vi.hoisted(() => ({
  createLibraryTalent: vi.fn(),
  createTeamLocation: vi.fn(),
  createSequences: vi.fn(),
  enqueueLibraryTalentSheet: vi.fn(),
  triggerTeamLocationSheet: vi.fn(),
  enhanceScriptToString: vi.fn(),
  uploadFile: vi.fn(async () => undefined),
  classifyUpload: vi.fn<
    () => Promise<{ status: 'cleared' | 'signed' | 'needs_portrait' }>
  >(async () => ({ status: 'cleared' })),
  attestUploads: vi.fn(async () => undefined),
  claimBytePlusVia: vi.fn<
    (options: { usingOwnFalKey: boolean }) => 'byteplus' | 'fal'
  >(() => 'fal'),
  resolveOptionalKey: vi.fn<
    () => Promise<{ source: 'team' | 'platform' } | null>
  >(async () => null),
}));

vi.mock('@/models/server/byteplus-config', () => ({
  claimBytePlusVia: mocks.claimBytePlusVia,
}));

vi.mock('@/cast/server/upload-rights', () => ({
  classifyUpload: mocks.classifyUpload,
  attestUploads: mocks.attestUploads,
}));

vi.mock('#storage', () => ({
  uploadFile: mocks.uploadFile,
  moveFile: vi.fn(async () => undefined),
}));

vi.mock('@/sequences/server/script-enhancement', () => ({
  enhanceScriptToString: mocks.enhanceScriptToString,
}));

vi.mock('@/sequences/server/create-sequences', () => ({
  createSequences: mocks.createSequences,
}));

vi.mock('@/cast/server/talent/create-library-talent', () => ({
  createLibraryTalent: mocks.createLibraryTalent,
}));

vi.mock('@/cast/server/talent/enqueue-library-talent-sheet', () => ({
  enqueueLibraryTalentSheet: mocks.enqueueLibraryTalentSheet,
}));

vi.mock('@/cast/server/locations/team-locations', () => ({
  createTeamLocation: mocks.createTeamLocation,
  triggerTeamLocationSheet: mocks.triggerTeamLocationSheet,
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
  statementVersion: 'portrait-rights-v1' as const,
  authorizationBasis: 'self',
};

const baseInput = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  enhance: 'off' as const,
  motion: false,
  music: false,
  startFrames: false,
  draftMotion: true,
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
  const teamLocations = vi.fn(async () => [] as { id: string; name: string }[]);
  const callLog: string[] = [];

  const ctx = {
    user: { id: 'user-1' },
    teamId: 'team-1',
    request: { ipAddress: '203.0.113.9', userAgent: 'vitest' },
    // stub covering styles.list + talent list/delete + the team's locations
    scopedDb: asStub<ScopedDb>({
      styles: { list: async () => [makeStyle()] },
      talent: { list: async () => [], delete: talentDelete },
      characters: { listTeam: async () => [] },
      locations: { listTeam: teamLocations, softDeleteForTeam: locationDelete },
      apiKeys: { resolveOptionalKey: mocks.resolveOptionalKey },
    }),
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    callLog.length = 0;
    mocks.claimBytePlusVia.mockReturnValue('byteplus');
    mocks.resolveOptionalKey.mockResolvedValue(null);
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

    teamLocations.mockResolvedValue([]);
    mocks.createTeamLocation.mockImplementation(
      async (
        _scopedDb: unknown,
        input: { name: string },
        opts: { triggerSheet: boolean }
      ) => {
        callLog.push(
          `createLocation:${input.name}:${String(opts.triggerSheet)}`
        );
        return { id: `loc-${input.name}`, name: input.name };
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
    mocks.triggerTeamLocationSheet.mockImplementation(async () => {
      callLog.push('triggerLocationSheet');
      return 'location-sheet-run';
    });
  });

  it('passes stop-at through and leaves voices to the deployment, with Match script when no style is named', async () => {
    await runOneShotCreate({ ...baseInput, stopAt: 'dialogue' }, ctx);
    expect(mocks.createSequences).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAt: 'dialogue',
        styleId: 'auto',
      }),
      expect.anything()
    );
    expect(
      mocks.createSequences.mock.calls[0]?.[0].generateVoices
    ).toBeUndefined();
  });

  describe('video defaults', () => {
    const created = () => mocks.createSequences.mock.calls[0]?.[0];

    it('starts on Seedance 2.5, drafted first, where the team reaches BytePlus', async () => {
      mocks.claimBytePlusVia.mockReturnValue('byteplus');
      await runOneShotCreate(baseInput, ctx);
      expect(created().videoModels).toEqual(['seedance_v2_5']);
      expect(created().draftMotion).toBe(true);
    });

    it('stays on the platform default with no draft where it does not', async () => {
      mocks.claimBytePlusVia.mockReturnValue('fal');
      await runOneShotCreate({ ...baseInput, draftMotion: true }, ctx);
      expect(created().videoModels).toEqual(['seedance_v2']);
      expect(created().draftMotion).toBe(false);
    });

    it('asks the route with the team\u2019s own fal key in view', async () => {
      mocks.resolveOptionalKey.mockResolvedValue({ source: 'team' });
      await runOneShotCreate(baseInput, ctx);
      expect(mocks.claimBytePlusVia).toHaveBeenCalledWith({
        native: true,
        usingOwnFalKey: true,
      });
    });

    it('keeps the caller\u2019s model and lets draftMotion be turned off', async () => {
      mocks.claimBytePlusVia.mockReturnValue('byteplus');
      await runOneShotCreate(
        { ...baseInput, videoModels: ['kling_v3_pro'], draftMotion: false },
        ctx
      );
      expect(created().videoModels).toEqual(['kling_v3_pro']);
      expect(created().draftMotion).toBe(false);
    });
  });

  it('creates what the app creates by default: no start frames, stopping at dialogue', async () => {
    await runOneShotCreate(baseInput, ctx);
    expect(mocks.createSequences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stopAt: 'dialogue',
        generateStartFrames: false,
        draftMotion: true,
      }),
      expect.anything()
    );
    await runOneShotCreate(
      { ...baseInput, startFrames: true, draftMotion: false, motion: true },
      ctx
    );
    expect(mocks.createSequences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stopAt: 'motion',
        generateStartFrames: true,
        draftMotion: false,
      }),
      expect.anything()
    );
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

  it('refuses a real-person reference with no portraitAttestation before any insert (#1581)', async () => {
    mocks.classifyUpload.mockResolvedValueOnce({ status: 'needs_portrait' });

    await expect(
      runOneShotCreate(
        {
          ...baseInput,
          locations: [
            {
              name: 'Pier',
              referenceImageUrls: ['https://cdn.example/pier-1.png'],
            },
          ],
        },
        ctx
      )
    ).rejects.toThrow(/Location "Pier" shows a real person/);

    expect(mocks.attestUploads).not.toHaveBeenCalled();
    expect(mocks.createTeamLocation).not.toHaveBeenCalled();
    expect(mocks.createSequences).not.toHaveBeenCalled();
  });

  it('records the portraitAttestation for a detected person, then creates (#1581)', async () => {
    mocks.classifyUpload.mockResolvedValueOnce({ status: 'needs_portrait' });

    await runOneShotCreate(
      {
        ...baseInput,
        characters: [
          {
            name: 'Ada',
            referenceImageUrls: ['https://cdn.example/ada-1.png'],
            portraitAttestation,
          },
        ],
      },
      ctx
    );

    expect(mocks.attestUploads).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          url: expect.stringContaining('/r2/talent/team-1/uploads/'),
          statementVersion: 'portrait-rights-v1',
          authorizationBasis: 'self',
        }),
      ],
      ctx.request
    );
    expect(mocks.createLibraryTalent).toHaveBeenCalledTimes(1);
  });

  it('makes an inline location a team location and starts its sheet only after the sequence exists (#1695)', async () => {
    await runOneShotCreate(
      {
        ...baseInput,
        style: 'Cinematic Noir',
        locations: [
          { name: 'Pier', referenceImageUrls: ['https://cdn.example/p.png'] },
          { name: 'Moon base', rendering: '3D animated, Pixar-like' },
        ],
      },
      ctx
    );

    expect(mocks.createTeamLocation.mock.calls[0]?.slice(1)).toEqual([
      {
        name: 'Pier',
        description: null,
        // The style names no medium: photoreal.
        rendering: 'Photoreal live action',
        photoUrls: [expect.stringContaining('/r2/locations/team-1/uploads/')],
      },
      { userId: 'user-1', teamId: 'team-1', triggerSheet: false },
    ]);
    expect(mocks.createTeamLocation.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ rendering: '3D animated, Pixar-like' })
    );
    expect(mocks.createSequences).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedLocationIds: ['loc-Pier', 'loc-Moon base'],
      }),
      expect.anything()
    );
    expect(callLog.indexOf('createSequences')).toBeGreaterThan(
      callLog.indexOf('createLocation:Moon base:false')
    );
    expect(callLog.indexOf('triggerLocationSheet')).toBeGreaterThan(
      callLog.indexOf('createSequences')
    );
    expect(mocks.triggerTeamLocationSheet).toHaveBeenCalledTimes(2);
    expect(mocks.triggerTeamLocationSheet).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1', teamId: 'team-1', locationId: 'loc-Pier' }
    );
    expect(locationDelete).not.toHaveBeenCalled();
  });

  it('names a team location by a string and makes nothing (#1695)', async () => {
    teamLocations.mockResolvedValue([{ id: 'loc-team', name: 'Rooftop Bar' }]);
    await runOneShotCreate({ ...baseInput, locations: ['rooftop bar'] }, ctx);
    expect(mocks.createTeamLocation).not.toHaveBeenCalled();
    expect(mocks.triggerTeamLocationSheet).not.toHaveBeenCalled();
    expect(mocks.createSequences).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedLocationIds: ['loc-team'] }),
      expect.anything()
    );
  });

  it('deletes the team locations it made, with no sheet, when sequence create fails (#1695)', async () => {
    mocks.createSequences.mockRejectedValue(new ValidationError('No credits'));
    await expect(
      runOneShotCreate({ ...baseInput, locations: [{ name: 'Pier' }] }, ctx)
    ).rejects.toThrow(/No credits/);
    expect(locationDelete).toHaveBeenCalledWith('loc-Pier');
    expect(mocks.triggerTeamLocationSheet).not.toHaveBeenCalled();
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
