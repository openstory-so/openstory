import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';

const fileExists = vi.fn();
vi.doMock('#storage', () => ({ fileExists }));

const {
  assertTeamUserUploadAttachable,
  isTeamUserUploadUrl,
  teamUserUploadStoragePath,
} = await import('./team-user-upload');

describe('isTeamUserUploadUrl', () => {
  it('accepts uploads/ and leftover temp/ under this team', () => {
    expect(
      isTeamUserUploadUrl(
        '/r2/talent/team-1/uploads/a.png',
        STORAGE_BUCKETS.TALENT,
        'team-1'
      )
    ).toBe(true);
    expect(
      isTeamUserUploadUrl(
        '/r2/locations/team-1/temp/a.png',
        STORAGE_BUCKETS.LOCATIONS,
        'team-1'
      )
    ).toBe(true);
  });

  it('rejects another team or an entity folder', () => {
    expect(
      isTeamUserUploadUrl(
        '/r2/talent/team-2/uploads/a.png',
        STORAGE_BUCKETS.TALENT,
        'team-1'
      )
    ).toBe(false);
    expect(
      isTeamUserUploadUrl(
        '/r2/talent/team-1/tal-1/headshot.png',
        STORAGE_BUCKETS.TALENT,
        'team-1'
      )
    ).toBe(false);
  });
});

describe('teamUserUploadStoragePath', () => {
  it('writes under uploads/', () => {
    expect(teamUserUploadStoragePath('team-1', 'up-1', 'png')).toBe(
      'team-1/uploads/up-1.png'
    );
  });
});

describe('assertTeamUserUploadAttachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileExists.mockResolvedValue(true);
  });

  it('returns the bucket-relative path when the object exists', async () => {
    await expect(
      assertTeamUserUploadAttachable({
        url: '/r2/talent/team-1/uploads/a.png',
        bucket: STORAGE_BUCKETS.TALENT,
        teamId: 'team-1',
      })
    ).resolves.toEqual({
      url: '/r2/talent/team-1/uploads/a.png',
      path: 'team-1/uploads/a.png',
    });
    expect(fileExists).toHaveBeenCalledWith(
      STORAGE_BUCKETS.TALENT,
      'team-1/uploads/a.png'
    );
  });

  it('refuses a missing object', async () => {
    fileExists.mockResolvedValue(false);
    await expect(
      assertTeamUserUploadAttachable({
        url: '/r2/talent/team-1/uploads/gone.png',
        bucket: STORAGE_BUCKETS.TALENT,
        teamId: 'team-1',
      })
    ).rejects.toThrow(/no longer available/);
  });

  it('refuses a path outside uploads/temp', async () => {
    await expect(
      assertTeamUserUploadAttachable({
        url: '/r2/talent/team-1/tal-1/a.png',
        bucket: STORAGE_BUCKETS.TALENT,
        teamId: 'team-1',
      })
    ).rejects.toThrow('Invalid storage path');
    expect(fileExists).not.toHaveBeenCalled();
  });
});
