import { describe, expect, it } from 'vitest';
import { roleHasPermission } from './organization-access';

describe('organization roles (#813)', () => {
  it('lets a member write a sequence', () => {
    expect(roleHasPermission('member', { sequence: ['create'] })).toBe(true);
  });

  it('lets an admin manage billing and members, and only an owner delete the organization', () => {
    expect(roleHasPermission('admin', { billing: ['update'] })).toBe(true);
    expect(roleHasPermission('member', { billing: ['update'] })).toBe(false);
    expect(roleHasPermission('admin', { member: ['create'] })).toBe(true);
    expect(roleHasPermission('admin', { organization: ['delete'] })).toBe(
      false
    );
    expect(roleHasPermission('owner', { organization: ['delete'] })).toBe(true);
  });

  it('accepts a comma-separated role list', () => {
    expect(roleHasPermission('member,admin', { billing: ['update'] })).toBe(
      true
    );
  });
});
