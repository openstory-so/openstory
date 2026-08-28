import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRestrictedError } from '@/lib/errors';

const mockLoadComplianceRecords = vi.fn();

vi.doMock('@/lib/db/scoped', () => ({
  loadComplianceRecords: mockLoadComplianceRecords,
}));
vi.doMock('#env', () => ({
  getEnv: () => ({ E2E_TEST: 'true' }),
}));

const { triggerWorkflow } = await import('./client');

const USER_ID = 'user_1';
const TEAM_ID = 'team_1';
const NOW = new Date('2026-08-12T12:00:00Z');

function row(action: 'generation_suspended' | 'account_suspended') {
  return {
    id: 'enf_1',
    action,
    reason: 'portrait_rights' as const,
    notes: null,
    effectiveAt: new Date(NOW.getTime() - 60_000),
    expiresAt: null,
    revokedAt: null,
  };
}

beforeEach(() => {
  mockLoadComplianceRecords.mockReset();
});

describe('triggerWorkflow enforcement backstop', () => {
  it('refuses /image when generation is suspended', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [row('generation_suspended')],
      verifications: [],
    });

    await expect(
      triggerWorkflow('/image', { userId: USER_ID, teamId: TEAM_ID })
    ).rejects.toBeInstanceOf(AccountRestrictedError);
  });

  it('allows sequence-export under a generation pause', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [row('generation_suspended')],
      verifications: [],
    });

    await expect(
      triggerWorkflow('/sequence-export', { userId: USER_ID, teamId: TEAM_ID })
    ).resolves.toMatch(/^mock-/);
  });

  it('refuses sequence-export when the account is read-only', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [row('account_suspended')],
      verifications: [],
    });

    await expect(
      triggerWorkflow('/sequence-export', { userId: USER_ID, teamId: TEAM_ID })
    ).rejects.toBeInstanceOf(AccountRestrictedError);
  });

  it('ignores revoked rows', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [{ ...row('generation_suspended'), revokedAt: NOW }],
      verifications: [],
    });

    await expect(
      triggerWorkflow('/image', { userId: USER_ID, teamId: TEAM_ID })
    ).resolves.toMatch(/^mock-/);
  });

  it('uses caller-supplied enforcement rows without a live load', async () => {
    await expect(
      triggerWorkflow(
        '/image',
        { userId: USER_ID, teamId: TEAM_ID },
        { enforcement: [row('generation_suspended')] }
      )
    ).rejects.toBeInstanceOf(AccountRestrictedError);
    expect(mockLoadComplianceRecords).not.toHaveBeenCalled();
  });
});
