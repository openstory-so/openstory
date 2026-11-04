import { describe, expect, it } from 'vitest';
import {
  isOrganizationTalentStoredUrl,
  requireStoredKey,
} from './copy-stored-image';

describe('isOrganizationTalentStoredUrl', () => {
  it('accepts this organization’s /r2/talent URLs', () => {
    expect(
      isOrganizationTalentStoredUrl(
        '/r2/talent/organization-a/tal1/img.png',
        'organization-a'
      )
    ).toBe(true);
  });

  it('rejects another organization’s talent prefix', () => {
    expect(
      isOrganizationTalentStoredUrl(
        '/r2/talent/organization-b/tal1/img.png',
        'organization-a'
      )
    ).toBe(false);
  });

  it('rejects a foreign host whose path looks like a talent key', () => {
    expect(
      isOrganizationTalentStoredUrl(
        'https://evil.example/talent/organization-a/img.png',
        'organization-a'
      )
    ).toBe(false);
  });
});

describe('requireStoredKey', () => {
  it('returns the R2 key for a stored URL', () => {
    expect(requireStoredKey('/r2/talent/organization-a/x.png')).toBe(
      'talent/organization-a/x.png'
    );
  });

  it('rejects a non-stored URL', () => {
    expect(() => requireStoredKey('https://evil.example/x.png')).toThrow(
      /not a stored/
    );
  });
});
