/**
 * Permission-boundary tests for sequence-characters server functions. The
 * `assertTalentAccessible` helper gates the recast endpoint and accepts
 * talents owned by the requesting team OR public talents — mirrors the
 * read-side ACL on `talent.getWithRelations`.
 */

import { describe, expect, it } from 'vitest';
import { assertTalentAccessible } from '@/cast/server/cast-generation';

describe('assertTalentAccessible', () => {
  it('accepts talent owned by the requesting team', () => {
    expect(() =>
      assertTalentAccessible({ teamId: 'team-A', isPublic: false }, 'team-A')
    ).not.toThrow();
  });

  it('accepts a public talent owned by another team', () => {
    expect(() =>
      assertTalentAccessible({ teamId: 'team-B', isPublic: true }, 'team-A')
    ).not.toThrow();
  });

  it('rejects a private talent owned by another team', () => {
    expect(() =>
      assertTalentAccessible({ teamId: 'team-B', isPublic: false }, 'team-A')
    ).toThrow('Talent does not belong to your team');
  });

  it('accepts a public talent owned by the requesting team', () => {
    expect(() =>
      assertTalentAccessible({ teamId: 'team-A', isPublic: true }, 'team-A')
    ).not.toThrow();
  });

  it('treats null isPublic as not public (rejects cross-team access)', () => {
    expect(() =>
      assertTalentAccessible({ teamId: 'team-B', isPublic: null }, 'team-A')
    ).toThrow('Talent does not belong to your team');
  });
});
