/**
 * The per-isolate team memo (#2082): a GET within the TTL shares one read, a
 * write always reads fresh, a failed read is not kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserTeamMembership = vi.fn();
const loadComplianceState = vi.fn();
vi.doMock('@/platform/server/db/scoped', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserTeamMembership,
}));
vi.doMock(
  '@/platform/server/compliance/generation-gate',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    loadComplianceState,
  })
);
const { resolveTeamAndCompliance } = await import('./team-memo');

const team = { organizationId: 'team-1' };
const compliance = { enforcement: { canAccess: true } };

beforeEach(() => {
  vi.useFakeTimers();
  getUserTeamMembership.mockReset().mockResolvedValue(team);
  loadComplianceState.mockReset().mockResolvedValue(compliance);
});

describe('resolveTeamAndCompliance (#2082)', () => {
  it('answers a second GET within the TTL from one read', async () => {
    const [a, b] = await Promise.all([
      resolveTeamAndCompliance('u-get', 'GET', 'team-1'),
      resolveTeamAndCompliance('u-get', 'GET', 'team-1'),
    ]);
    expect(a).toEqual({ team, compliance });
    expect(b).toBe(a);
    expect(getUserTeamMembership).toHaveBeenCalledTimes(1);
    expect(loadComplianceState).toHaveBeenCalledTimes(1);
  });

  it('reads fresh for a write, and refreshes the memo', async () => {
    await resolveTeamAndCompliance('u-post', 'GET', 'team-1');
    await resolveTeamAndCompliance('u-post', 'POST', 'team-1');
    expect(getUserTeamMembership).toHaveBeenCalledTimes(2);
    // The next GET is served from the write's read.
    await resolveTeamAndCompliance('u-post', 'GET', 'team-1');
    expect(getUserTeamMembership).toHaveBeenCalledTimes(2);
  });

  it('reads again after the TTL', async () => {
    await resolveTeamAndCompliance('u-ttl', 'GET', 'team-1');
    vi.advanceTimersByTime(5_001);
    await resolveTeamAndCompliance('u-ttl', 'GET', 'team-1');
    expect(getUserTeamMembership).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    getUserTeamMembership.mockRejectedValueOnce(
      new Error('primary unreachable')
    );
    await expect(
      resolveTeamAndCompliance('u-fail', 'GET', 'team-1')
    ).rejects.toThrow('primary unreachable');
    await expect(
      resolveTeamAndCompliance('u-fail', 'GET', 'team-1')
    ).resolves.toEqual({
      team,
      compliance,
    });
    expect(getUserTeamMembership).toHaveBeenCalledTimes(2);
  });

  it('does not share a memo entry across active organizations', async () => {
    await resolveTeamAndCompliance('u-active', 'GET', 'org-a');
    await resolveTeamAndCompliance('u-active', 'GET', 'org-b');
    expect(getUserTeamMembership).toHaveBeenCalledTimes(2);
    expect(getUserTeamMembership).toHaveBeenNthCalledWith(
      1,
      'u-active',
      'org-a'
    );
    expect(getUserTeamMembership).toHaveBeenNthCalledWith(
      2,
      'u-active',
      'org-b'
    );
  });
});
