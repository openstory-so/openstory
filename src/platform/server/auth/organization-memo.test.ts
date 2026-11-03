/**
 * The per-isolate team memo (#2082): a GET within the TTL shares one read, a
 * write always reads fresh, a failed read is not kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserOrganizationMembership = vi.fn();
const loadComplianceState = vi.fn();
vi.doMock('@/platform/server/db/scoped', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserOrganizationMembership,
}));
vi.doMock(
  '@/platform/server/compliance/generation-gate',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    loadComplianceState,
  })
);
const { resolveOrganizationAndCompliance } =
  await import('./organization-memo');

const team = { organizationId: 'team-1' };
const compliance = { enforcement: { canAccess: true } };

beforeEach(() => {
  vi.useFakeTimers();
  getUserOrganizationMembership.mockReset().mockResolvedValue(team);
  loadComplianceState.mockReset().mockResolvedValue(compliance);
});

describe('resolveOrganizationAndCompliance (#2082)', () => {
  it('answers a second GET within the TTL from one read', async () => {
    const [a, b] = await Promise.all([
      resolveOrganizationAndCompliance('u-get', 'GET', 'team-1'),
      resolveOrganizationAndCompliance('u-get', 'GET', 'team-1'),
    ]);
    expect(a).toEqual({ team, compliance });
    expect(b).toBe(a);
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(1);
    expect(loadComplianceState).toHaveBeenCalledTimes(1);
  });

  it('reads fresh for a write, and refreshes the memo', async () => {
    await resolveOrganizationAndCompliance('u-post', 'GET', 'team-1');
    await resolveOrganizationAndCompliance('u-post', 'POST', 'team-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
    // The next GET is served from the write's read.
    await resolveOrganizationAndCompliance('u-post', 'GET', 'team-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
  });

  it('reads again after the TTL', async () => {
    await resolveOrganizationAndCompliance('u-ttl', 'GET', 'team-1');
    vi.advanceTimersByTime(5_001);
    await resolveOrganizationAndCompliance('u-ttl', 'GET', 'team-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    getUserOrganizationMembership.mockRejectedValueOnce(
      new Error('primary unreachable')
    );
    await expect(
      resolveOrganizationAndCompliance('u-fail', 'GET', 'team-1')
    ).rejects.toThrow('primary unreachable');
    await expect(
      resolveOrganizationAndCompliance('u-fail', 'GET', 'team-1')
    ).resolves.toEqual({
      team,
      compliance,
    });
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
  });

  it('does not share a memo entry across active organizations', async () => {
    await resolveOrganizationAndCompliance('u-active', 'GET', 'org-a');
    await resolveOrganizationAndCompliance('u-active', 'GET', 'org-b');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
    expect(getUserOrganizationMembership).toHaveBeenNthCalledWith(
      1,
      'u-active',
      'org-a'
    );
    expect(getUserOrganizationMembership).toHaveBeenNthCalledWith(
      2,
      'u-active',
      'org-b'
    );
  });
});
