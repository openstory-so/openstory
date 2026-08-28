import type {
  LibraryLocation,
  Style,
  Talent,
  TalentWithSheets,
} from '@/lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the runtime side-effecting deps so resolve.ts (and the safe-fetch ingest
// it uses) import cleanly in Node and element ingestion is observable.
const uploadFileMock = vi.fn(async () => undefined);

vi.doMock('#storage', () => ({ uploadFile: uploadFileMock }));
vi.doMock('@/lib/storage/buckets', () => ({
  STORAGE_BUCKETS: {
    ELEMENTS: 'elements',
    TALENT: 'talent',
    LOCATIONS: 'locations',
  },
  getPublicUrl: (bucket: string, path: string) =>
    `https://cdn.test/${bucket}/${path}`,
}));
vi.doMock('@/lib/db/id', () => ({ generateId: () => 'gen-1' }));

const { resolveStyle, resolveTalentIds, resolveLocationIds, ingestElements } =
  await import('./resolve');

function makeStyle(overrides: Partial<Style> = {}): Style {
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
    ...overrides,
  };
}

function makeTalent(
  overrides: Partial<TalentWithSheets> = {}
): TalentWithSheets {
  const base: Talent = {
    id: 'talent-1',
    teamId: 'team-1',
    name: 'Ada Lovelace',
    description: null,
    imageUrl: null,
    imagePath: null,
    isFavorite: false,
    isHuman: true,
    isInTeamLibrary: true,
    isPublic: false,
    isTemplate: false,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    ...base,
    sheets: [],
    sheetCount: 0,
    defaultSheet: null,
    ...overrides,
  };
}

function makeLocation(
  overrides: Partial<LibraryLocation> = {}
): LibraryLocation {
  return {
    id: 'loc-1',
    teamId: 'team-1',
    name: 'Rooftop Bar',
    description: null,
    referenceImageUrl: null,
    referenceImagePath: null,
    isPublic: false,
    isTemplate: false,
    referenceInputHash: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('resolveStyle', () => {
  const styles = [
    makeStyle({ id: 'style-popular', name: 'Cinematic Noir' }),
    makeStyle({ id: 'style-2', name: 'Pixel Art Adventure' }),
  ];
  const deps = { styles: { list: async () => styles } };

  it('auto-picks the first (most popular) style when no ref is given', async () => {
    const style = await resolveStyle(deps, undefined);
    expect(style.id).toBe('style-popular');
  });

  it('matches by exact id', async () => {
    const style = await resolveStyle(deps, 'style-2');
    expect(style.name).toBe('Pixel Art Adventure');
  });

  it('matches by name (case-insensitive)', async () => {
    const style = await resolveStyle(deps, 'cinematic noir');
    expect(style.id).toBe('style-popular');
  });

  it('matches by slugified name', async () => {
    const style = await resolveStyle(deps, 'pixel-art-adventure');
    expect(style.id).toBe('style-2');
  });

  it('throws NotFound when a given ref matches nothing', async () => {
    await expect(resolveStyle(deps, 'does-not-exist')).rejects.toThrow(
      /No style found/
    );
  });

  it('throws when the team has no styles at all', async () => {
    await expect(
      resolveStyle({ styles: { list: async () => [] } }, undefined)
    ).rejects.toThrow(/No styles are available/);
  });
});

describe('resolveTalentIds', () => {
  it('resolves existing talent by name and id (no create)', async () => {
    const talent = [
      makeTalent({ id: 't-ada', name: 'Ada Lovelace' }),
      makeTalent({ id: 't-grace', name: 'Grace Hopper' }),
    ];
    const createTalent = vi.fn();
    const ids = await resolveTalentIds(
      { talent: { list: async () => talent }, createTalent },
      ['Ada Lovelace', 't-grace']
    );
    expect(ids).toEqual(['t-ada', 't-grace']);
    expect(createTalent).not.toHaveBeenCalled();
  });

  it('delegates inline-create to createTalent and mixes with refs', async () => {
    const talent = [makeTalent({ id: 't-ada', name: 'Ada Lovelace' })];
    const createTalent = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveTalentIds(
      { talent: { list: async () => talent }, createTalent },
      ['Ada Lovelace', { name: 'Hero', description: 'brave', isHuman: true }]
    );
    expect(ids).toEqual(['t-ada', 'new-Hero']);
    expect(createTalent).toHaveBeenCalledWith({
      name: 'Hero',
      description: 'brave',
      isHuman: true,
    });
  });

  it('throws NotFound when a referenced talent is missing', async () => {
    await expect(
      resolveTalentIds(
        { talent: { list: async () => [] }, createTalent: vi.fn() },
        ['Nobody']
      )
    ).rejects.toThrow(/No character\/talent found/);
  });

  it('dedupes overlapping ids', async () => {
    const talent = [makeTalent({ id: 't-ada', name: 'Ada Lovelace' })];
    const ids = await resolveTalentIds(
      { talent: { list: async () => talent }, createTalent: vi.fn() },
      ['t-ada', 'Ada Lovelace']
    );
    expect(ids).toEqual(['t-ada']);
  });

  it('reuses an existing talent by name instead of creating a duplicate', async () => {
    const talent = [makeTalent({ id: 't-ada', name: 'Ada Lovelace' })];
    const createTalent = vi.fn();
    const ids = await resolveTalentIds(
      { talent: { list: async () => talent }, createTalent },
      [{ name: 'Ada Lovelace', isHuman: true }]
    );
    expect(ids).toEqual(['t-ada']);
    expect(createTalent).not.toHaveBeenCalled();
  });

  it('creates only once when the same name is inlined twice', async () => {
    const createTalent = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveTalentIds(
      { talent: { list: async () => [] }, createTalent },
      [{ name: 'Hero' }, { name: 'Hero' }]
    );
    expect(ids).toEqual(['new-Hero']);
    expect(createTalent).toHaveBeenCalledTimes(1);
  });
});

describe('resolveLocationIds', () => {
  it('resolves existing and delegates inline-create to createLocation', async () => {
    const locations = [makeLocation({ id: 'l-roof', name: 'Rooftop Bar' })];
    const createLocation = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveLocationIds(
      { locations: { list: async () => locations }, createLocation },
      ['Rooftop Bar', { name: 'Beach' }]
    );
    expect(ids).toEqual(['l-roof', 'new-Beach']);
    expect(createLocation).toHaveBeenCalledWith({ name: 'Beach' });
  });

  it('reuses an existing location by name instead of creating a duplicate', async () => {
    const locations = [makeLocation({ id: 'l-roof', name: 'Rooftop Bar' })];
    const createLocation = vi.fn();
    const ids = await resolveLocationIds(
      { locations: { list: async () => locations }, createLocation },
      [{ name: 'Rooftop Bar' }]
    );
    expect(ids).toEqual(['l-roof']);
    expect(createLocation).not.toHaveBeenCalled();
  });
});

describe('ingestElements', () => {
  beforeEach(() => {
    uploadFileMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new ArrayBuffer(8),
      }))
    );
  });

  it('returns [] for no elements', async () => {
    expect(await ingestElements('team-1', undefined)).toEqual([]);
    expect(await ingestElements('team-1', [])).toEqual([]);
  });

  it('uploads to a temp path and returns a promotable upload (vision deferred)', async () => {
    const [upload] = await ingestElements('team-1', [
      { url: 'https://host/logo.png', filename: 'logo.png', token: 'LOGO' },
    ]);

    expect(uploadFileMock).toHaveBeenCalledWith(
      'elements',
      'team-1/temp/gen-1.png',
      expect.any(Uint8Array),
      { contentType: 'image/png' }
    );
    // No description/consistencyTag: vision runs in the element-vision workflow.
    expect(upload).toEqual({
      tempPath: 'elements/team-1/temp/gen-1.png',
      tempPublicUrl: 'https://cdn.test/elements/team-1/temp/gen-1.png',
      filename: 'logo.png',
      token: 'LOGO',
    });
  });

  it('derives the extension from the response content-type', async () => {
    const [upload] = await ingestElements('team-1', [
      { url: 'https://host/no-ext' },
    ]);
    expect(upload?.filename).toBe('element.png');
  });

  it('rejects an SSRF target before any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      ingestElements('team-1', [{ url: 'http://169.254.169.254/latest' }])
    ).rejects.toThrow(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when the source image cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      }))
    );
    await expect(
      ingestElements('team-1', [{ url: 'https://host/missing.png' }])
    ).rejects.toThrow(/could not be fetched/);
  });
});
