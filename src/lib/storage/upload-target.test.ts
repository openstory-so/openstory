import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserTeamMembership = vi.fn();
vi.doMock('@/lib/db/scoped', () => ({ getUserTeamMembership }));

const isSystemAdmin = vi.fn();
vi.doMock('@/lib/auth/system-admin', () => ({ isSystemAdmin }));

// Dynamic import so the mocks apply (vi.doMock is not hoisted).
const { resolveUploadTarget } = await import('./upload-target');

const TEAM = '01JQTEAMAAAAAAAAAAAAAAAAAA';
const OTHER_TEAM = '01JQTEAMBBBBBBBBBBBBBBBBBB';
const USER = { id: 'user-1', email: 'member@example.com' };

function request(path: string): Request {
  return new Request(
    `https://app.example.com/api/storage/multipart?bucket=videos&path=${encodeURIComponent(path)}`
  );
}

beforeEach(() => {
  getUserTeamMembership.mockReset();
  getUserTeamMembership.mockImplementation((_userId: string, teamId: string) =>
    Promise.resolve(teamId === TEAM ? { teamId, role: 'member' } : null)
  );
  isSystemAdmin.mockReset();
  isSystemAdmin.mockReturnValue(false);
});

describe('resolveUploadTarget', () => {
  it('authorizes the team named in the path, not the caller’s “first” team', async () => {
    const resolved = await resolveUploadTarget(
      request(`teams/${TEAM}/sequences/s1/exports/abc_openstory.mp4`),
      USER
    );

    expect(resolved.ok).toBe(true);
    expect(getUserTeamMembership).toHaveBeenCalledWith('user-1', TEAM);
  });

  it('403s when the caller is not a member of the path’s team', async () => {
    const resolved = await resolveUploadTarget(
      request(`teams/${OTHER_TEAM}/sequences/s1/exports/abc_openstory.mp4`),
      USER
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.response.status).toBe(403);
  });

  it('lets a system admin write into a customer’s prefix', async () => {
    isSystemAdmin.mockReturnValue(true);

    const resolved = await resolveUploadTarget(
      request(`teams/${OTHER_TEAM}/sequences/s1/exports/abc_openstory.mp4`),
      { id: 'admin-1', email: 'admin@openstory.so' }
    );

    expect(resolved.ok).toBe(true);
  });

  it('reads the owner segment from a bare `<teamId>/…` path', async () => {
    const resolved = await resolveUploadTarget(
      request(`${TEAM}/talent/portrait.png`),
      USER
    );

    expect(resolved.ok).toBe(true);
  });

  it('rejects traversal before it ever reaches the membership check', async () => {
    const resolved = await resolveUploadTarget(
      request(`teams/${TEAM}/../${OTHER_TEAM}/x.mp4`),
      USER
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.response.status).toBe(400);
    expect(getUserTeamMembership).not.toHaveBeenCalled();
  });
});
