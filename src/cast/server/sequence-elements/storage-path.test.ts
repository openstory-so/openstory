import { describe, expect, it } from 'vitest';
import { STORAGE_BUCKETS, buildR2Key } from '@/platform/server/storage/buckets';
import {
  DRAFT_ELEMENT_UPLOAD_PREFIX,
  elementImageUrlFromPath,
  isValidElementStoragePath,
} from './storage-path';

describe('isValidElementStoragePath', () => {
  const organizationId = 'organizationA';

  it('accepts a well-formed path under the organization prefix', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationA/file.png',
        organizationId
      )
    ).toBe(true);
  });

  it('accepts nested paths under the organization prefix', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationA/sub/dir/file.png',
        organizationId
      )
    ).toBe(true);
  });

  it('rejects a `..` segment that traverses out of the organization namespace', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationA/../organizationB/file.png',
        organizationId
      )
    ).toBe(false);
  });

  it('rejects empty segments (double slash) that would normalize away', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationA//file.png',
        organizationId
      )
    ).toBe(false);
  });

  it('rejects an empty rest after the organization prefix (path equals the prefix)', () => {
    expect(
      isValidElementStoragePath('elements/organizationA/', organizationId)
    ).toBe(false);
  });

  it('rejects another organization prefix even with a valid-looking suffix', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationB/file.png',
        organizationId
      )
    ).toBe(false);
  });

  it('rejects a prefix-collision organization id (organizationAB starts with organizationA but is different)', () => {
    expect(
      isValidElementStoragePath(
        'elements/organizationAB/file.png',
        organizationId
      )
    ).toBe(false);
  });
});

describe('draft upload keys round-trip', () => {
  // `presignDraftElementUploadFn` mints `<organizationId>/<prefix>/<id>.<ext>` and
  // `getSignedUploadUrl` returns it bucket-prefixed via `buildR2Key`. That
  // exact string is what the client stores as `tempPath` and hands back at
  // attach time — if either side's shape drifts, every draft element is
  // rejected at create with nothing else to catch it.
  const organizationId = 'organizationA';
  const key = buildR2Key(
    STORAGE_BUCKETS.ELEMENTS,
    `${organizationId}/${DRAFT_ELEMENT_UPLOAD_PREFIX}/01JXYZ.png`
  );

  it('is accepted by the namespace check', () => {
    expect(isValidElementStoragePath(key, organizationId)).toBe(true);
  });

  it('derives a public URL pointing back at the same object', () => {
    expect(elementImageUrlFromPath(key)).toBe(
      '/r2/elements/organizationA/uploads/01JXYZ.png'
    );
  });
});
