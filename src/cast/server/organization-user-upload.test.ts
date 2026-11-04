import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';

const fileExists = vi.fn();
vi.doMock('#storage', () => ({ fileExists }));

const {
  assertOrganizationUserUploadAttachable,
  isOrganizationUserUploadUrl,
  organizationUserUploadStoragePath,
} = await import('./organization-user-upload');

describe('isOrganizationUserUploadUrl', () => {
  it('accepts uploads/ and leftover temp/ under this organization', () => {
    expect(
      isOrganizationUserUploadUrl(
        '/r2/talent/organization-1/uploads/a.png',
        STORAGE_BUCKETS.TALENT,
        'organization-1'
      )
    ).toBe(true);
    expect(
      isOrganizationUserUploadUrl(
        '/r2/locations/organization-1/temp/a.png',
        STORAGE_BUCKETS.LOCATIONS,
        'organization-1'
      )
    ).toBe(true);
  });

  it('rejects another organization or an entity folder', () => {
    expect(
      isOrganizationUserUploadUrl(
        '/r2/talent/organization-2/uploads/a.png',
        STORAGE_BUCKETS.TALENT,
        'organization-1'
      )
    ).toBe(false);
    expect(
      isOrganizationUserUploadUrl(
        '/r2/talent/organization-1/tal-1/headshot.png',
        STORAGE_BUCKETS.TALENT,
        'organization-1'
      )
    ).toBe(false);
  });
});

describe('organizationUserUploadStoragePath', () => {
  it('writes under uploads/', () => {
    expect(
      organizationUserUploadStoragePath('organization-1', 'up-1', 'png')
    ).toBe('organization-1/uploads/up-1.png');
  });
});

describe('assertOrganizationUserUploadAttachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileExists.mockResolvedValue(true);
  });

  it('returns the bucket-relative path when the object exists', async () => {
    await expect(
      assertOrganizationUserUploadAttachable({
        url: '/r2/talent/organization-1/uploads/a.png',
        bucket: STORAGE_BUCKETS.TALENT,
        organizationId: 'organization-1',
      })
    ).resolves.toEqual({
      url: '/r2/talent/organization-1/uploads/a.png',
      path: 'organization-1/uploads/a.png',
    });
    expect(fileExists).toHaveBeenCalledWith(
      STORAGE_BUCKETS.TALENT,
      'organization-1/uploads/a.png'
    );
  });

  it('refuses a missing object', async () => {
    fileExists.mockResolvedValue(false);
    await expect(
      assertOrganizationUserUploadAttachable({
        url: '/r2/talent/organization-1/uploads/gone.png',
        bucket: STORAGE_BUCKETS.TALENT,
        organizationId: 'organization-1',
      })
    ).rejects.toThrow(/no longer available/);
  });

  it('refuses a path outside uploads/temp', async () => {
    await expect(
      assertOrganizationUserUploadAttachable({
        url: '/r2/talent/organization-1/tal-1/a.png',
        bucket: STORAGE_BUCKETS.TALENT,
        organizationId: 'organization-1',
      })
    ).rejects.toThrow('Invalid storage path');
    expect(fileExists).not.toHaveBeenCalled();
  });
});
