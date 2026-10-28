import { describe, expect, it } from 'vitest';
import {
  assetDownloadUrl,
  projectSequenceAssets,
  type SequenceAssetSource,
} from './sequence-assets';

const empty: SequenceAssetSource = {
  sequence: { id: 'seq', title: 'Pilot', script: null },
  scenes: [],
  shots: [],
  frames: [],
  stills: [],
  segments: [],
  videos: [],
  characters: [],
  sheets: [],
  voiceTakes: [],
  locations: [],
  locationSheets: [],
  photos: [],
  elements: [],
  speeches: [],
  sections: [],
  music: [],
  selectedMusicVariantId: null,
  prompts: [],
  style: null,
  exports: [],
};

function project(
  source: Partial<SequenceAssetSource>,
  scope: 'selected' | 'history' = 'selected',
  includeExports = false
) {
  return projectSequenceAssets(
    { ...empty, ...source, sequence: source.sequence ?? empty.sequence },
    { scope, includeExports }
  );
}

describe('assetDownloadUrl', () => {
  it('prefers an /r2 url and appends download', () => {
    expect(
      assetDownloadUrl({
        url: '/r2/team/a.png?x=1',
        storagePath: 'other.png',
      })
    ).toBe('/r2/team/a.png?download');
  });

  it('builds from a storage key when the url is a provider address', () => {
    expect(
      assetDownloadUrl({
        url: 'https://r2/v.mp4',
        storagePath: '/r2/team/seq/v.mp4',
      })
    ).toBe('/r2/team/seq/v.mp4?download');
  });

  it('drops a path that climbs out of the bucket', () => {
    expect(
      assetDownloadUrl({ url: null, storagePath: 'team/../../secret' })
    ).toBeNull();
  });
});

describe('projectSequenceAssets', () => {
  it('keeps the selected still, the script and one segment file', () => {
    const assets = project({
      sequence: { id: 'seq', title: 'Pilot', script: 'INT. ROOM' },
      scenes: [{ id: 'scene', orderIndex: 0 }],
      shots: [
        {
          id: 'shot-a',
          sceneId: 'scene',
          shotNumber: 1,
          renderSegmentId: 'seg',
        },
        {
          id: 'shot-b',
          sceneId: 'scene',
          shotNumber: 2,
          renderSegmentId: 'seg',
        },
      ],
      frames: [
        { id: 'frame', shotId: 'shot-a', selectedImageVersionId: 'still-1' },
      ],
      stills: [
        {
          id: 'still-1',
          frameId: 'frame',
          kind: 'model',
          url: null,
          storagePath: 'team/still.png',
          status: 'completed',
          discardedAt: null,
        },
        {
          id: 'still-old',
          frameId: 'frame',
          kind: 'model',
          url: null,
          storagePath: 'team/old.png',
          status: 'completed',
          discardedAt: new Date(),
        },
      ],
      segments: [{ id: 'seg', selectedVideoVersionId: 'vid' }],
      videos: [
        {
          id: 'vid',
          renderSegmentId: 'seg',
          url: null,
          storagePath: 'team/v.mp4',
          status: 'completed',
          discardedAt: null,
        },
      ],
      prompts: [{ id: 'prompt', shotId: 'shot-a', text: 'She looks up.' }],
    });
    expect(assets.map((asset) => asset.relativePath)).toEqual([
      'scenes/1/shots/1/prompt.txt',
      'scenes/1/shots/1/still.png',
      'script.txt',
      'segments/vid.mp4',
    ]);
    expect(assets.find((asset) => asset.kind === 'video')?.owners).toEqual([
      'shot-a',
      'shot-b',
    ]);
  });

  it('adds discarded versions under their own names and keeps the stable still', () => {
    const assets = project(
      {
        scenes: [{ id: 'scene', orderIndex: 0 }],
        shots: [
          {
            id: 'shot',
            sceneId: 'scene',
            shotNumber: 1,
            renderSegmentId: null,
          },
        ],
        frames: [
          { id: 'frame', shotId: 'shot', selectedImageVersionId: 'still-1' },
        ],
        stills: [
          {
            id: 'still-1',
            frameId: 'frame',
            kind: 'model',
            url: '/r2/team/still.png',
            storagePath: 'team/still.png',
            status: 'completed',
            discardedAt: null,
          },
          {
            id: 'still-old',
            frameId: 'frame',
            kind: 'model',
            url: null,
            storagePath: 'team/old.png',
            status: 'completed',
            discardedAt: new Date(),
          },
        ],
      },
      'history'
    );
    expect(assets.map((asset) => asset.relativePath)).toEqual([
      'scenes/1/shots/1/still.png',
      'scenes/1/shots/1/still.still-1.png',
      'scenes/1/shots/1/still.still-old.png',
    ]);
    expect(
      assets.find((asset) => asset.relativePath.endsWith('old.png'))
    ).toMatchObject({
      discarded: true,
      selected: false,
    });
  });

  it('puts one speech file and the cuts of the shots that use it', () => {
    const assets = project({
      speeches: [
        {
          id: 'speech',
          url: '/r2/team/speech.wav',
          storageKey: 'team/speech.wav',
        },
      ],
      sections: [
        {
          shotId: 'shot-a',
          speechId: 'speech',
          fromSeconds: 0,
          toSeconds: 1.5,
          selected: true,
        },
        {
          shotId: 'shot-b',
          speechId: 'speech',
          fromSeconds: 1.5,
          toSeconds: 3,
          selected: false,
        },
      ],
    });
    const cuts = assets.find((asset) => asset.kind === 'dialogue_cuts');
    expect(assets.map((asset) => asset.relativePath)).toEqual([
      'dialogue/speech.cuts.json',
      'dialogue/speech.wav',
    ]);
    expect(JSON.parse(cuts?.text ?? '[]')).toEqual([
      { shotId: 'shot-a', startSeconds: 0, endSeconds: 1.5 },
    ]);
    expect(assets.find((asset) => asset.kind === 'dialogue')?.owners).toEqual([
      'shot-a',
      'shot-b',
    ]);
  });

  it('marks a character sheet as shared and leaves a provider url out', () => {
    const assets = project({
      characters: [
        {
          id: 'ada',
          name: 'Ada',
          looks: [
            {
              id: 'ada',
              name: 'Default',
              deleted: false,
              isDefault: true,
              selectedSheetVersionId: 'sheet',
              sheetImageUrl: null,
              sheetImagePath: null,
              sheetPortraitUrl: null,
            },
          ],
        },
      ],
      sheets: [
        {
          id: 'sheet',
          characterId: 'ada',
          lookId: null,
          url: null,
          storagePath: 'team/sheet.png',
          portraitUrl: '/r2/team/portrait.png',
          status: 'completed',
          discardedAt: null,
        },
      ],
      style: {
        id: 'style',
        previewUrl: 'https://cdn.example/preview.png',
        sampleVideos: [{ url: '/r2/team/sample.mp4', order: 0 }],
      },
      elements: [
        {
          id: 'el',
          token: 'LOGO',
          imageUrl: null,
          imagePath: 'team/logo.png',
        },
        {
          id: 'bad',
          token: 'not a token',
          imageUrl: '/r2/team/x.mp3',
          imagePath: 'team/x.mp3',
        },
      ],
    });
    expect(
      assets.find((asset) => asset.kind === 'character_sheet')
    ).toMatchObject({
      relativePath: 'cast/ada/looks/ada/sheet.png',
      shared: true,
      selected: true,
    });
    expect(
      assets.find((asset) => asset.kind === 'character_portrait')?.relativePath
    ).toBe('cast/ada/looks/ada/portrait.png');
    expect(
      assets.some((asset) => asset.kind === 'style' && asset.role === 'preview')
    ).toBe(false);
    expect(assets.map((asset) => asset.relativePath)).toContain(
      'style/style/sample-0.mp4'
    );
    expect(assets.map((asset) => asset.relativePath)).toEqual(
      expect.arrayContaining(['elements/LOGO.png', 'elements/element-bad.mp3'])
    );
  });

  it('treats a null default-look pointer as the character id', () => {
    const sheet = {
      id: 'ada',
      characterId: 'ada',
      lookId: null,
      url: '/r2/team/sheet.png',
      storagePath: 'team/sheet.png',
      portraitUrl: null,
      status: 'completed',
      discardedAt: null,
    };
    const look = {
      id: 'ada',
      name: 'Default',
      deleted: false,
      isDefault: true,
      selectedSheetVersionId: null,
      sheetImageUrl: '/r2/team/sheet.png',
      sheetImagePath: 'team/sheet.png',
      sheetPortraitUrl: null,
    };
    const selected = project({
      characters: [{ id: 'ada', name: 'Ada', looks: [look] }],
      sheets: [sheet],
    });
    expect(
      selected.find((asset) => asset.kind === 'character_sheet')
    ).toMatchObject({
      relativePath: 'cast/ada/looks/ada/sheet.png',
      selected: true,
      versionId: 'ada',
    });

    const otherLook = { ...look, id: 'gala', isDefault: false };
    const skipped = project({
      characters: [{ id: 'ada', name: 'Ada', looks: [otherLook] }],
      sheets: [{ ...sheet, lookId: 'gala' }],
    });
    expect(skipped.some((asset) => asset.kind === 'character_sheet')).toBe(
      false
    );
  });

  it('treats a null location pointer as the location id', () => {
    const assets = project({
      locations: [
        {
          id: 'room',
          name: 'Room',
          selectedReferenceVersionId: null,
          referenceImageUrl: '/r2/team/room.png',
          referenceImagePath: 'team/room.png',
          referencePortraitUrl: null,
        },
      ],
      locationSheets: [
        {
          id: 'room',
          locationId: 'room',
          url: '/r2/team/room.png',
          storagePath: 'team/room.png',
          portraitUrl: null,
          status: 'completed',
          discardedAt: null,
        },
      ],
    });
    expect(
      assets.find((asset) => asset.kind === 'location_sheet')
    ).toMatchObject({
      relativePath: 'locations/room/sheet.png',
      selected: true,
      versionId: 'room',
    });
  });

  it('leaves rendered cuts out until they are asked for', () => {
    const source = {
      exports: [
        { id: 'new', url: null, storagePath: 'team/new.mp4' },
        { id: 'old', url: null, storagePath: 'team/old.mp4' },
      ],
    };
    expect(project(source)).toEqual([]);
    expect(
      project(source, 'selected', true).map((asset) => asset.relativePath)
    ).toEqual(['exports/new.mp4']);
    expect(
      project(source, 'history', true).map((asset) => asset.selected)
    ).toEqual([true, false]);
  });
});
