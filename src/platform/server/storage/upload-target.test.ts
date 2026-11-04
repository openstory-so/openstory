import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserOrganizationMembership = vi.fn();
vi.doMock('@/platform/server/db/scoped', () => ({
  getUserOrganizationMembership,
}));

const isSystemAdmin = vi.fn();
vi.doMock('@/platform/server/auth/system-admin', () => ({ isSystemAdmin }));

const fileExists = vi.fn();
vi.doMock('#storage', () => ({ fileExists }));

// Dynamic import so the mocks apply (vi.doMock is not hoisted).
const { resolveUploadTarget } = await import('./upload-target');

const ORGANIZATION = '01JQTEAMAAAAAAAAAAAAAAAAAA';
const OTHER_ORGANIZATION = '01JQTEAMBBBBBBBBBBBBBBBBBB';
const USER = { id: 'user-1', email: 'member@example.com' };

function request(path: string): Request {
  return new Request(
    `https://app.example.com/api/storage/multipart?bucket=videos&path=${encodeURIComponent(path)}`
  );
}

beforeEach(() => {
  getUserOrganizationMembership.mockReset();
  getUserOrganizationMembership.mockImplementation(
    (_userId: string, organizationId: string) =>
      Promise.resolve(
        organizationId === ORGANIZATION
          ? { organizationId, role: 'member' }
          : null
      )
  );
  isSystemAdmin.mockReset();
  isSystemAdmin.mockReturnValue(false);
  fileExists.mockReset();
  fileExists.mockResolvedValue(false);
});

describe('stitch files are written once (#2127)', () => {
  const stitchRequest = (path: string) =>
    new Request(
      `https://app.example.com/api/storage/upload?bucket=stitches&path=${encodeURIComponent(path)}&contentType=image%2Fpng`
    );

  it('takes a first write under the organization', async () => {
    const resolved = await resolveUploadTarget(
      stitchRequest(`${ORGANIZATION}/01STITCH/0.png`),
      USER
    );
    expect(resolved.ok).toBe(true);
    expect(fileExists).toHaveBeenCalledWith(
      'stitches',
      `${ORGANIZATION}/01STITCH/0.png`
    );
  });

  it('409s a write over a file that is already there', async () => {
    fileExists.mockResolvedValue(true);
    const resolved = await resolveUploadTarget(
      stitchRequest(`${ORGANIZATION}/01STITCH/0.png`),
      USER
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.response.status).toBe(409);
  });

  it('does not ask storage for any other bucket', async () => {
    fileExists.mockResolvedValue(true);
    const resolved = await resolveUploadTarget(
      request(`teams/${ORGANIZATION}/sequences/s1/exports/abc_openstory.mp4`),
      USER
    );
    expect(resolved.ok).toBe(true);
    expect(fileExists).not.toHaveBeenCalled();
  });
});

describe('checked uploads are written once (#2192)', () => {
  const talentRequest = (path: string) =>
    new Request(
      `https://app.example.com/api/storage/upload?bucket=talent&path=${encodeURIComponent(path)}&contentType=image%2Fpng`
    );

  it('takes a first write, and 409s new bytes under a checked key', async () => {
    const path = `${ORGANIZATION}/uploads/01UP.png`;
    expect((await resolveUploadTarget(talentRequest(path), USER)).ok).toBe(
      true
    );
    fileExists.mockResolvedValue(true);
    const again = await resolveUploadTarget(talentRequest(path), USER);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.response.status).toBe(409);
  });
});

describe('resolveUploadTarget', () => {
  it('authorizes the organization named in the path, not the caller’s “first” organization', async () => {
    const resolved = await resolveUploadTarget(
      request(`org/${ORGANIZATION}/sequences/s1/exports/abc_openstory.mp4`),
      USER
    );

    expect(resolved.ok).toBe(true);
    expect(getUserOrganizationMembership).toHaveBeenCalledWith(
      'user-1',
      ORGANIZATION
    );
  });

  it('403s when the caller is not a member of the path’s organization', async () => {
    const resolved = await resolveUploadTarget(
      request(
        `org/${OTHER_ORGANIZATION}/sequences/s1/exports/abc_openstory.mp4`
      ),
      USER
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.response.status).toBe(403);
  });

  it('lets a system admin write into a customer’s prefix', async () => {
    isSystemAdmin.mockReturnValue(true);

    const resolved = await resolveUploadTarget(
      request(
        `teams/${OTHER_ORGANIZATION}/sequences/s1/exports/abc_openstory.mp4`
      ),
      { id: 'admin-1', email: 'admin@openstory.so' }
    );

    expect(resolved.ok).toBe(true);
  });

  it('reads the owner segment from a bare `<organizationId>/…` path', async () => {
    const resolved = await resolveUploadTarget(
      request(`${ORGANIZATION}/talent/portrait.png`),
      USER
    );

    expect(resolved.ok).toBe(true);
  });

  it('rejects traversal before it ever reaches the membership check', async () => {
    const resolved = await resolveUploadTarget(
      request(`teams/${ORGANIZATION}/../${OTHER_ORGANIZATION}/x.mp4`),
      USER
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.response.status).toBe(400);
    expect(getUserOrganizationMembership).not.toHaveBeenCalled();
  });
});
