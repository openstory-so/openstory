import { describe, expect, it } from 'vitest';
import { STORAGE_BUCKETS, buildR2Key } from '@/platform/server/storage/buckets';
import {
  DRAFT_ELEMENT_UPLOAD_PREFIX,
  elementImageUrlFromPath,
  isValidElementStoragePath,
} from './storage-path';

describe('isValidElementStoragePath', () => {
  const teamId = 'teamA';

  it('accepts a well-formed path under the team prefix', () => {
    expect(isValidElementStoragePath('elements/teamA/file.png', teamId)).toBe(
      true
    );
  });

  it('accepts nested paths under the team prefix', () => {
    expect(
      isValidElementStoragePath('elements/teamA/sub/dir/file.png', teamId)
    ).toBe(true);
  });

  it('rejects a `..` segment that traverses out of the team namespace', () => {
    expect(
      isValidElementStoragePath('elements/teamA/../teamB/file.png', teamId)
    ).toBe(false);
  });

  it('rejects empty segments (double slash) that would normalize away', () => {
    expect(isValidElementStoragePath('elements/teamA//file.png', teamId)).toBe(
      false
    );
  });

  it('rejects an empty rest after the team prefix (path equals the prefix)', () => {
    expect(isValidElementStoragePath('elements/teamA/', teamId)).toBe(false);
  });

  it('rejects another team prefix even with a valid-looking suffix', () => {
    expect(isValidElementStoragePath('elements/teamB/file.png', teamId)).toBe(
      false
    );
  });

  it('rejects a prefix-collision team id (teamAB starts with teamA but is different)', () => {
    expect(isValidElementStoragePath('elements/teamAB/file.png', teamId)).toBe(
      false
    );
  });
});

describe('draft upload keys round-trip', () => {
  // `presignDraftElementUploadFn` mints `<teamId>/<prefix>/<id>.<ext>` and
  // `getSignedUploadUrl` returns it bucket-prefixed via `buildR2Key`. That
  // exact string is what the client stores as `tempPath` and hands back at
  // attach time — if either side's shape drifts, every draft element is
  // rejected at create with nothing else to catch it.
  const teamId = 'teamA';
  const key = buildR2Key(
    STORAGE_BUCKETS.ELEMENTS,
    `${teamId}/${DRAFT_ELEMENT_UPLOAD_PREFIX}/01JXYZ.png`
  );

  it('is accepted by the namespace check', () => {
    expect(isValidElementStoragePath(key, teamId)).toBe(true);
  });

  it('derives a public URL pointing back at the same object', () => {
    expect(elementImageUrlFromPath(key)).toBe(
      '/r2/elements/teamA/uploads/01JXYZ.png'
    );
  });
});
