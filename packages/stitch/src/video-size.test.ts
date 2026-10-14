import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVideoDisplaySize } from './video-size.js';

describe('readVideoDisplaySize', () => {
  it('names the file when the header is not a video', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-video-size-'));
    try {
      const file = join(cwd, 'shot.mp4');
      await writeFile(file, 'video');
      await expect(readVideoDisplaySize(file)).rejects.toThrow(/shot\.mp4/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
