import { describe, expect, it, vi } from 'vitest';
import { playHoverPreview } from './play-hover-preview';

function videoRejecting(error: unknown): HTMLVideoElement {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: play() is all the helper reads
  return { play: () => Promise.reject(error) } as unknown as HTMLVideoElement;
}

async function settle(error: unknown): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onRejection);
  playHoverPreview(videoRejecting(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off('unhandledRejection', onRejection);
  return unhandled;
}

describe('playHoverPreview', () => {
  it.each(['AbortError', 'NotSupportedError'])('ignores %s', async (name) => {
    expect(await settle(new DOMException('x', name))).toEqual([]);
  });

  it('rethrows any other rejection', async () => {
    const error = new DOMException('blocked', 'NotAllowedError');
    expect(await settle(error)).toEqual([error]);
  });

  it('starts playback', () => {
    const play = vi.fn(() => Promise.resolve());
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double
    playHoverPreview({ play } as unknown as HTMLVideoElement);
    expect(play).toHaveBeenCalledOnce();
  });
});
