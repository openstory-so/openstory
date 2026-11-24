/**
 * The per-isolate organization memo (#2082): a GET within the TTL shares one read, a
 * write always reads fresh, a failed read is not kept, the shared read is held with `waitUntil` (#2421).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserOrganizationMembership = vi.fn();
const waitUntil = vi.fn();
vi.doMock('cloudflare:workers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitUntil,
}));
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

const membership = { organizationId: 'organization-1' };
const compliance = { enforcement: { canAccess: true } };

beforeEach(() => {
  vi.useFakeTimers();
  getUserOrganizationMembership.mockReset().mockResolvedValue(membership);
  loadComplianceState.mockReset().mockResolvedValue(compliance);
  waitUntil.mockReset();
});

describe('resolveOrganizationAndCompliance (#2082)', () => {
  it('answers a second GET within the TTL from one read', async () => {
    const [a, b] = await Promise.all([
      resolveOrganizationAndCompliance('u-get', 'GET', 'organization-1'),
      resolveOrganizationAndCompliance('u-get', 'GET', 'organization-1'),
    ]);
    expect(a).toEqual({ organization: membership, compliance });
    expect(b).toBe(a);
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(1);
    expect(loadComplianceState).toHaveBeenCalledTimes(1);
  });

  it('holds the shared read with waitUntil in the request that starts it (#2421)', async () => {
    let fail!: (error: Error) => void;
    getUserOrganizationMembership.mockReturnValueOnce(
      new Promise((_, reject) => (fail = reject))
    );
    const first = resolveOrganizationAndCompliance(
      'u-hold',
      'GET',
      'organization-1'
    );
    const second = resolveOrganizationAndCompliance(
      'u-hold',
      'GET',
      'organization-1'
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    fail(new Error('primary unreachable'));
    // The awaiters see the failure; the held copy settles without rejecting.
    await expect(first).rejects.toThrow('primary unreachable');
    await expect(second).rejects.toThrow('primary unreachable');
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it('drops the compliance read of an organization the user is not in (#2234)', async () => {
    getUserOrganizationMembership.mockResolvedValueOnce(null);
    loadComplianceState.mockResolvedValueOnce({
      enforcement: { canAccess: false },
    });
    await expect(
      resolveOrganizationAndCompliance('u-out', 'GET', 'organization-x')
    ).resolves.toEqual({ organization: null, compliance: null });
  });

  it('reads fresh for a write, and refreshes the memo', async () => {
    await resolveOrganizationAndCompliance('u-post', 'GET', 'organization-1');
    await resolveOrganizationAndCompliance('u-post', 'POST', 'organization-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
    // The next GET is served from the write's read.
    await resolveOrganizationAndCompliance('u-post', 'GET', 'organization-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
  });

  it('reads again after the TTL', async () => {
    await resolveOrganizationAndCompliance('u-ttl', 'GET', 'organization-1');
    vi.advanceTimersByTime(5_001);
    await resolveOrganizationAndCompliance('u-ttl', 'GET', 'organization-1');
    expect(getUserOrganizationMembership).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    getUserOrganizationMembership.mockRejectedValueOnce(
      new Error('primary unreachable')
    );
    await expect(
      resolveOrganizationAndCompliance('u-fail', 'GET', 'organization-1')
    ).rejects.toThrow('primary unreachable');
    await expect(
      resolveOrganizationAndCompliance('u-fail', 'GET', 'organization-1')
    ).resolves.toEqual({
      organization: membership,
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
