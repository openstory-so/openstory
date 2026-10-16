/**
 * The per-isolate team memo (#2082): a GET within the TTL shares one read, a
 * write always reads fresh, a failed read is not kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUserTeam = vi.fn();
const loadComplianceState = vi.fn();
vi.doMock('@/platform/server/db/scoped', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveUserTeam,
}));
vi.doMock(
  '@/platform/server/compliance/generation-gate',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    loadComplianceState,
  })
);
const { resolveTeamAndCompliance } = await import('./team-memo');

const team = { teamId: 'team-1' };
const compliance = { enforcement: { canAccess: true } };

beforeEach(() => {
  vi.useFakeTimers();
  resolveUserTeam.mockReset().mockResolvedValue(team);
  loadComplianceState.mockReset().mockResolvedValue(compliance);
});

describe('resolveTeamAndCompliance (#2082)', () => {
  it('answers a second GET within the TTL from one read', async () => {
    const [a, b] = await Promise.all([
      resolveTeamAndCompliance('u-get', 'GET'),
      resolveTeamAndCompliance('u-get', 'GET'),
    ]);
    expect(a).toEqual({ team, compliance });
    expect(b).toBe(a);
    expect(resolveUserTeam).toHaveBeenCalledTimes(1);
    expect(loadComplianceState).toHaveBeenCalledTimes(1);
  });

  it('reads fresh for a write, and refreshes the memo', async () => {
    await resolveTeamAndCompliance('u-post', 'GET');
    await resolveTeamAndCompliance('u-post', 'POST');
    expect(resolveUserTeam).toHaveBeenCalledTimes(2);
    // The next GET is served from the write's read.
    await resolveTeamAndCompliance('u-post', 'GET');
    expect(resolveUserTeam).toHaveBeenCalledTimes(2);
  });

  it('reads again after the TTL', async () => {
    await resolveTeamAndCompliance('u-ttl', 'GET');
    vi.advanceTimersByTime(5_001);
    await resolveTeamAndCompliance('u-ttl', 'GET');
    expect(resolveUserTeam).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read', async () => {
    resolveUserTeam.mockRejectedValueOnce(new Error('primary unreachable'));
    await expect(resolveTeamAndCompliance('u-fail', 'GET')).rejects.toThrow(
      'primary unreachable'
    );
    await expect(resolveTeamAndCompliance('u-fail', 'GET')).resolves.toEqual({
      team,
      compliance,
    });
    expect(resolveUserTeam).toHaveBeenCalledTimes(2);
  });
});
