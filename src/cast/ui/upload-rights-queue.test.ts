import { describe, expect, it, vi } from 'vitest';
import type { UploadRef } from '@/cast/upload-rights';
import { createUploadRightsQueue } from './upload-rights-queue';

const ref = (filename: string): UploadRef => ({
  url: `https://example.com/${filename}`,
  filename,
});

function queueOf(status: 'needs_portrait' | 'cleared' = 'needs_portrait') {
  return createUploadRightsQueue({
    classify: async (refs) => refs.map(() => ({ status })),
  });
}

describe('createUploadRightsQueue', () => {
  it('settles two concurrent sign-offs and attests both urls', async () => {
    const queue = queueOf();
    const first = queue.ensureUploadRights([ref('a.png')]);
    const second = queue.ensureUploadRights([ref('b.png')]);
    await vi.waitFor(() => {
      expect(queue.getSnapshot()).toEqual({
        open: true,
        names: ['a.png', 'b.png'],
      });
    });

    const attested: string[] = [];
    const settled = Promise.all([first, second]);
    await queue.confirm(async (refs) => {
      attested.push(...refs.map((item) => item.url));
    });
    await settled;

    expect(attested).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
    expect(queue.getSnapshot().open).toBe(false);
  });

  it('rejects every queued sign-off when the dialog is cancelled', async () => {
    const queue = queueOf();
    const first = queue.ensureUploadRights([ref('a.png')]);
    const second = queue.ensureUploadRights([ref('b.png')]);
    await vi.waitFor(() => expect(queue.getSnapshot().names).toHaveLength(2));

    const rejected = Promise.all([
      expect(first).rejects.toThrow(
        'Rights to this person’s likeness were not confirmed'
      ),
      expect(second).rejects.toThrow(
        'Rights to this person’s likeness were not confirmed'
      ),
    ]);
    queue.decline();
    await rejected;
    expect(queue.getSnapshot().open).toBe(false);
  });

  it('leaves a sign-off that arrives during confirm still waiting', async () => {
    const queue = queueOf();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.ensureUploadRights([ref('a.png')]);
    await vi.waitFor(() =>
      expect(queue.getSnapshot().names).toEqual(['a.png'])
    );

    const confirming = queue.confirm(async () => {
      await gate;
    });
    const second = queue.ensureUploadRights([ref('b.png')]);
    await vi.waitFor(() =>
      expect(queue.getSnapshot().names).toEqual(['a.png', 'b.png'])
    );
    release();
    await confirming;
    await first;

    expect(queue.getSnapshot().names).toEqual(['b.png']);

    const rejected = expect(second).rejects.toThrow(
      'Rights to this person’s likeness were not confirmed'
    );
    queue.decline();
    await rejected;
  });

  it('does not open when every image is already cleared', async () => {
    const queue = queueOf('cleared');
    await queue.ensureUploadRights([ref('a.png'), ref('b.png')]);
    expect(queue.getSnapshot().open).toBe(false);
  });
});
