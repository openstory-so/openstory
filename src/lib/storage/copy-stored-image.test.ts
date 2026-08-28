import { describe, expect, it } from 'vitest';
import { isTeamTalentStoredUrl, requireStoredKey } from './copy-stored-image';

describe('isTeamTalentStoredUrl', () => {
  it('accepts this team’s /r2/talent URLs', () => {
    expect(
      isTeamTalentStoredUrl('/r2/talent/team-a/tal1/img.png', 'team-a')
    ).toBe(true);
  });

  it('rejects another team’s talent prefix', () => {
    expect(
      isTeamTalentStoredUrl('/r2/talent/team-b/tal1/img.png', 'team-a')
    ).toBe(false);
  });

  it('rejects a foreign host whose path looks like a talent key', () => {
    expect(
      isTeamTalentStoredUrl(
        'https://evil.example/talent/team-a/img.png',
        'team-a'
      )
    ).toBe(false);
  });
});

describe('requireStoredKey', () => {
  it('returns the R2 key for a stored URL', () => {
    expect(requireStoredKey('/r2/talent/team-a/x.png')).toBe(
      'talent/team-a/x.png'
    );
  });

  it('rejects a non-stored URL', () => {
    expect(() => requireStoredKey('https://evil.example/x.png')).toThrow(
      /not a stored/
    );
  });
});
