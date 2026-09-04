import { describe, expect, it } from 'vitest';
import { theatrePlaybackMode } from './theatre-playback-mode';

const base = {
  freshExportUrl: null as string | null,
  serverExportAvailable: true,
  canTransmux: true as boolean | null,
  previewLive: false,
  playCutFailed: false,
};

describe('theatrePlaybackMode', () => {
  it('plays a matching export natively', () => {
    expect(
      theatrePlaybackMode({ ...base, freshExportUrl: '/r2/cut.mp4' })
    ).toBe('native');
  });

  it('waits for a server cut when transmux + container are available', () => {
    expect(theatrePlaybackMode(base)).toBe('wait-for-cut');
  });

  it('stitches when the container is missing', () => {
    expect(theatrePlaybackMode({ ...base, serverExportAvailable: false })).toBe(
      'stitch'
    );
  });

  it('stitches mixed-resolution cuts the container cannot render', () => {
    expect(theatrePlaybackMode({ ...base, canTransmux: false })).toBe('stitch');
  });

  it('stitches until the codec probe has finished', () => {
    expect(theatrePlaybackMode({ ...base, canTransmux: null })).toBe('stitch');
  });

  it('stitches after Preview now or a failed server render', () => {
    expect(theatrePlaybackMode({ ...base, previewLive: true })).toBe('stitch');
    expect(theatrePlaybackMode({ ...base, playCutFailed: true })).toBe(
      'stitch'
    );
  });

  it('prefers the cached MP4 over preview-live', () => {
    expect(
      theatrePlaybackMode({
        ...base,
        freshExportUrl: '/r2/cut.mp4',
        previewLive: true,
      })
    ).toBe('native');
  });
});
