import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  SequenceAsset,
  SequenceAssetsBody,
} from '@/sequences/sequence-assets';

import {
  SequenceAssetsView,
  sequenceAssetFolderName,
  sequencePullCommand,
} from './sequence-assets-page';

const still: SequenceAsset = {
  id: 'scenes/1/shots/1/still.png',
  kind: 'still',
  role: 'still',
  group: 'Scene 1',
  label: 'Still',
  selected: true,
  discarded: false,
  shared: false,
  relativePath: 'scenes/1/shots/1/still.png',
  url: '/r2/team/still.png?download',
  text: null,
  contentType: 'image/png',
  versionId: 'still-1',
  owners: ['shot-1'],
};

function body(assets: SequenceAsset[]): SequenceAssetsBody {
  return {
    sequenceId: 'SEQ',
    title: 'Room',
    scope: 'selected',
    includeExports: false,
    assets,
  };
}

describe('sequence assets page', () => {
  it('lists a file and shows a command that can be copied', () => {
    const html = renderToStaticMarkup(
      <SequenceAssetsView
        sequenceId="SEQ"
        body={body([still])}
        scope="selected"
        includeExports={false}
        onScope={() => {}}
        onExports={() => {}}
      />
    );
    expect(html).toContain('Scene 1');
    expect(html).toContain('scenes/1/shots/1/still.png');
    expect(html).toContain('Download');
    expect(html).toContain('Current cut');
    expect(html).toContain('Download folder');
    expect(html).toContain('npx @openstory/stitch pull SEQ');
    expect(html).toContain('Copy Pull command');
    expect(html).toContain('# Run this to download these files.');
    expect(html).toContain('href="/r2/team/still.png?download"');
  });

  it('names the folder after the sequence title', () => {
    expect(sequenceAssetFolderName(body([]))).toBe('Room');
    expect(sequenceAssetFolderName({ ...body([]), title: 'a/b:c' })).toBe(
      'a b c'
    );
    expect(sequenceAssetFolderName({ ...body([]), title: '  ' })).toBe('SEQ');
  });

  it('builds the pull command from the toggles and the page origin', () => {
    expect(
      sequencePullCommand('SEQ', {
        history: false,
        exports: false,
        origin: 'https://openstory.so',
      })
    ).toBe('npx @openstory/stitch pull SEQ');
    expect(
      sequencePullCommand('SEQ', {
        history: true,
        exports: true,
        origin: 'https://snappy-wombat.openstory.so',
      })
    ).toBe(
      'npx @openstory/stitch pull SEQ --history --exports --origin https://snappy-wombat.openstory.so'
    );
  });

  it('says when the sequence has no stored files', () => {
    const html = renderToStaticMarkup(
      <SequenceAssetsView
        sequenceId="SEQ"
        body={body([])}
        scope="selected"
        includeExports={false}
        onScope={() => {}}
        onExports={() => {}}
      />
    );
    expect(html).toContain('This sequence has no stored files yet.');
  });
});
