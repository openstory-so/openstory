import { describe, expect, it } from 'vitest';

import { pendingAssets, versionsByPath } from './sequence-asset-folder';

describe('sequence asset folder', () => {
  it('skips a path that still has the same version', () => {
    const previous = versionsByPath({
      assets: [{ relativePath: 'script.txt', versionId: 's1' }],
    });
    const assets = [
      {
        relativePath: 'script.txt',
        versionId: 's1',
        url: null,
        text: 'INT. ROOM',
      },
      {
        relativePath: 'segments/v.mp4',
        versionId: 'v1',
        url: '/r2/team/v.mp4?download',
        text: null,
      },
      {
        relativePath: '../secret',
        versionId: 'x',
        url: '/r2/x',
        text: null,
      },
    ];
    expect(
      pendingAssets(assets, previous, (path) => path === 'script.txt').map(
        (asset) => asset.relativePath
      )
    ).toEqual(['segments/v.mp4']);
  });

  it('rewrites a path when the version changed or the file is gone', () => {
    const assets = [
      {
        relativePath: 'script.txt',
        versionId: 's2',
        url: null,
        text: 'INT. ROOM',
      },
      {
        relativePath: 'segments/v.mp4',
        versionId: 'v1',
        url: '/r2/team/v.mp4?download',
        text: null,
      },
    ];
    const previous = versionsByPath({
      assets: [
        { relativePath: 'script.txt', versionId: 's1' },
        { relativePath: 'segments/v.mp4', versionId: 'v1' },
      ],
    });
    expect(
      pendingAssets(assets, previous, () => true).map(
        (asset) => asset.relativePath
      )
    ).toEqual(['script.txt']);
    expect(
      pendingAssets(assets, previous, () => false).map(
        (asset) => asset.relativePath
      )
    ).toEqual(['script.txt', 'segments/v.mp4']);
  });
});
