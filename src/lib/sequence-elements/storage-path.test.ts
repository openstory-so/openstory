import { describe, expect, it } from 'vitest';
import { isValidElementStoragePath } from './storage-path';

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
