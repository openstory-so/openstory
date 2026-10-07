import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.doMock('./stitched-player-surface.js', () => {
  throw new Error('Video.js surface was imported during the server render');
});

const { StitchedPlayer } = await import('./react.js');

describe('StitchedPlayer on the server', () => {
  it('renders the fallback and does not load the Video.js surface', () => {
    const html = renderToString(
      <StitchedPlayer
        clips={[{ videoUrl: '/a.mp4', posterUrl: null, cues: [] }]}
        musicUrl={null}
        musicGainDb={0}
        musicEnabled={false}
        fallback={<p>loading</p>}
      />
    );
    expect(html).toContain('loading');
  });
});
