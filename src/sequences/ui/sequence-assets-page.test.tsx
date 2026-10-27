import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  SequenceAsset,
  SequenceAssetsBody,
} from '@/sequences/sequence-assets';

import { SequenceAssetsView } from './sequence-assets-page';

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
  it('lists a file and names the npx command when the folder picker is absent', () => {
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
    expect(html).toContain('Download');
    expect(html).toContain('npx @openstory/stitch pull SEQ');
    expect(html).toContain('href="/r2/team/still.png?download"');
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
