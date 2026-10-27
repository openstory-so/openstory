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
});
