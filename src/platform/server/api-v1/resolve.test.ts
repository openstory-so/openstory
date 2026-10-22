import type { Style } from '@/platform/server/db/schema';
import { ConflictError, NotFoundError } from '@/platform/errors';
import type { TeamLocation } from '@/cast/server/db/locations';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the runtime side-effecting deps so resolve.ts (and the safe-fetch ingest
// it uses) import cleanly in Node and element ingestion is observable.
const uploadFileMock = vi.fn(async () => undefined);

vi.doMock('#storage', () => ({ uploadFile: uploadFileMock }));
vi.doMock('@/platform/server/storage/buckets', () => ({
  STORAGE_BUCKETS: {
    ELEMENTS: 'elements',
    CHARACTERS: 'characters',
    LOCATIONS: 'locations',
  },
  getPublicUrl: (bucket: string, path: string) =>
    `https://cdn.test/${bucket}/${path}`,
}));
vi.doMock('@/platform/id', () => ({ generateId: () => 'gen-1' }));

const {
  resolveStyle,
  resolveCharacterIds,
  resolveLocationIds,
  ingestElements,
} = await import('./resolve');

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

function makeLocation(overrides: Partial<TeamLocation> = {}): TeamLocation {
  return {
    id: 'loc-1',
    name: 'Rooftop Bar',
    description: null,
    referenceImageUrl: null,
    referencePortraitUrl: null,
    referenceStatus: 'pending',
    lastUsedAt: null,
    usedAnywhere: false,
    sequences: [],
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

function library(rows: Array<{ id: string; name: string }>) {
  return {
    listTeam: async () =>
      rows.map((row) => ({
        ...row,
        physicalDescription: null,
        voiceOnly: false,
        lastUsedAt: null,
        castAnywhere: false,
        sheetImageUrl: null,
        sheetPortraitUrl: null,
        sequences: [],
      })),
  };
}

describe('resolveCharacterIds', () => {
  const empty = library([]);

  it('resolves an existing team character by name and id', async () => {
    const createCharacter = vi.fn();
    const ids = await resolveCharacterIds(
      {
        characters: library([
          { id: 'c-ada', name: 'Ada Lovelace' },
          { id: 'c-grace', name: 'Grace Hopper' },
        ]),
        createCharacter,
      },
      ['Ada Lovelace', 'c-grace']
    );
    expect(ids).toEqual(['c-ada', 'c-grace']);
    expect(createCharacter).not.toHaveBeenCalled();
  });

  it('delegates inline-create to createCharacter and mixes with refs', async () => {
    const createCharacter = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveCharacterIds(
      {
        characters: library([{ id: 'c-ada', name: 'Ada Lovelace' }]),
        createCharacter,
      },
      ['Ada Lovelace', { name: 'Hero', description: 'brave', isHuman: true }]
    );
    expect(ids).toEqual(['c-ada', 'new-Hero']);
    expect(createCharacter).toHaveBeenCalledWith({
      name: 'Hero',
      description: 'brave',
      isHuman: true,
    });
  });

  it('throws NotFound when a referenced character is missing', async () => {
    await expect(
      resolveCharacterIds({ characters: empty, createCharacter: vi.fn() }, [
        'Nobody',
      ])
    ).rejects.toThrow(/No character found/);
  });

  it('dedupes overlapping ids', async () => {
    const ids = await resolveCharacterIds(
      {
        characters: library([{ id: 'c-ada', name: 'Ada Lovelace' }]),
        createCharacter: vi.fn(),
      },
      ['c-ada', 'Ada Lovelace']
    );
    expect(ids).toEqual(['c-ada']);
  });

  it('refuses an inline create whose name a team character has, naming its id', async () => {
    const createCharacter = vi.fn();
    await expect(
      resolveCharacterIds(
        {
          characters: library([{ id: 'c-ada', name: 'Ada Lovelace' }]),
          createCharacter,
        },
        [{ name: 'ada lovelace', isHuman: true }]
      )
    ).rejects.toThrow(/already has a character named "ada lovelace".*c-ada/);
    expect(createCharacter).not.toHaveBeenCalled();
  });

  it('creates only once when the same name is inlined twice', async () => {
    const createCharacter = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveCharacterIds(
      { characters: empty, createCharacter },
      [{ name: 'Hero' }, { name: 'Hero' }]
    );
    expect(ids).toEqual(['new-Hero']);
    expect(createCharacter).toHaveBeenCalledTimes(1);
  });

  it('a name two characters share is refused and asks for the id', async () => {
    await expect(
      resolveCharacterIds(
        {
          characters: library([
            { id: 'c-1', name: 'Sarah' },
            { id: 'c-2', name: 'sarah' },
          ]),
          createCharacter: vi.fn(),
        },
        ['Sarah']
      )
    ).rejects.toThrow(/names 2 characters\. Use the id: c-1, c-2/);
  });
});

describe('resolveLocationIds', () => {
  // `listTeam` is the team's own locations: another team's never appear.
  const team = [
    makeLocation({ id: 'l-roof', name: 'Rooftop Bar' }),
    makeLocation({ id: 'l-pier-1', name: 'Pier' }),
    makeLocation({ id: 'l-pier-2', name: 'pier' }),
  ];
  const deps = (createLocation = vi.fn()) => ({
    locations: { listTeam: async () => team },
    createLocation,
  });

  it('names a team location by id', async () => {
    expect(await resolveLocationIds(deps(), ['l-roof'])).toEqual(['l-roof']);
  });

  it('names a team location by name, forgivingly, and dedupes', async () => {
    expect(
      await resolveLocationIds(deps(), ['rooftop-bar', 'Rooftop Bar', 'l-roof'])
    ).toEqual(['l-roof']);
  });

  it('asks for the id when two team locations share the name', async () => {
    await expect(resolveLocationIds(deps(), ['Pier'])).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ConflictError);
        expect(String(error)).toContain('l-pier-1, l-pier-2');
        return true;
      }
    );
    // The id still names one of them.
    expect(await resolveLocationIds(deps(), ['l-pier-2'])).toEqual([
      'l-pier-2',
    ]);
  });

  it('does not find another team\u2019s id, or a name nothing has', async () => {
    await expect(
      resolveLocationIds(deps(), ['l-other-team'])
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveLocationIds(deps(), ['Beach'])).rejects.toThrow(
      'No location found matching "Beach".'
    );
  });

  it('resolves existing and delegates inline-create to createLocation', async () => {
    const createLocation = vi.fn(async (input: { name: string }) => ({
      id: `new-${input.name}`,
    }));
    const ids = await resolveLocationIds(deps(createLocation), [
      'Rooftop Bar',
      { name: 'Beach' },
      { name: 'beach' },
    ]);
    expect(ids).toEqual(['l-roof', 'new-Beach']);
    expect(createLocation).toHaveBeenCalledTimes(1);
    expect(createLocation).toHaveBeenCalledWith({ name: 'Beach' });
  });

  it('reuses the team location of that name instead of creating a duplicate', async () => {
    const createLocation = vi.fn();
    expect(
      await resolveLocationIds(deps(createLocation), [{ name: 'Rooftop Bar' }])
    ).toEqual(['l-roof']);
    await expect(
      resolveLocationIds(deps(createLocation), [{ name: 'Pier' }])
    ).rejects.toBeInstanceOf(ConflictError);
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

  it('uploads to the permanent uploads prefix and defers vision', async () => {
    const [upload] = await ingestElements('team-1', [
      { url: 'https://host/logo.png', filename: 'logo.png', token: 'LOGO' },
    ]);

    expect(uploadFileMock).toHaveBeenCalledWith(
      'elements',
      'team-1/uploads/gen-1.png',
      expect.any(Uint8Array),
      { contentType: 'image/png' }
    );
    // No description/consistencyTag: vision runs in the element-vision workflow.
    expect(upload).toEqual({
      tempPath: 'elements/team-1/uploads/gen-1.png',
      tempPublicUrl: 'https://cdn.test/elements/team-1/uploads/gen-1.png',
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
