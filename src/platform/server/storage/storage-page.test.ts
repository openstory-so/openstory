import { describe, expect, it, vi } from 'vitest';
const list = vi.hoisted(() => vi.fn());
vi.mock('cloudflare:workers', () => ({ env: { R2_STORAGE_BUCKET: { list } } }));
import { listFilesPage } from './storage-cloudflare';

describe('storage continuation pages', () => {
  it('uses the exact directory prefix and preserves R2 continuation and metadata', async () => {
    list.mockResolvedValue({
      objects: [
        {
          key: 'talent/team-a/temp/a.mp3',
          size: 42,
          uploaded: new Date('2026-01-01'),
          httpMetadata: { contentType: 'audio/mpeg' },
        },
      ],
      truncated: true,
      cursor: 'next',
    });
    const page = await listFilesPage('talent', 'team-a/temp', {
      limit: 1,
      cursor: 'previous',
    });
    expect(list).toHaveBeenCalledWith({
      prefix: 'talent/team-a/temp/',
      limit: 1,
      cursor: 'previous',
      include: ['httpMetadata'],
    });
    expect(page).toEqual({
      files: [
        {
          name: 'a.mp3',
          url: '/r2/talent/team-a/temp/a.mp3',
          size: 42,
          contentType: 'audio/mpeg',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: 'next',
    });
    list.mockResolvedValue({ objects: [], truncated: false });
    expect(
      (
        await listFilesPage('talent', 'team-a/temp', {
          limit: 1,
          cursor: 'next',
        })
      ).nextCursor
    ).toBeNull();
  });
});
