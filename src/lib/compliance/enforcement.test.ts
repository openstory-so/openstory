import { assert, describe, expect, it } from 'vitest';
import { AccountRestrictedError } from '@/lib/errors';
import {
  assertCanGenerate,
  assertCanWrite,
  isActionActive,
  resolveEnforcementState,
  restrictionNotice,
  type EnforcementRow,
} from './enforcement';
import type { EnforcementActionType } from '@/lib/db/schema/compliance';

const NOW = new Date('2026-08-12T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<EnforcementRow> = {}): EnforcementRow {
  return {
    id: 'enf_1',
    action: 'generation_suspended',
    reason: 'portrait_rights',
    notes: null,
    effectiveAt: new Date(NOW.getTime() - HOUR),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('isActionActive', () => {
  it('counts an unrevoked, in-window action', () => {
    expect(isActionActive(row(), NOW)).toBe(true);
  });

  it('ignores a revoked action, so a granted appeal lifts the block', () => {
    expect(isActionActive(row({ revokedAt: new Date(NOW) }), NOW)).toBe(false);
  });

  it('ignores an action scheduled for the future', () => {
    expect(
      isActionActive(row({ effectiveAt: new Date(NOW.getTime() + HOUR) }), NOW)
    ).toBe(false);
  });

  it('ignores an expired action without needing a sweep to rewrite it', () => {
    expect(
      isActionActive(row({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)
    ).toBe(false);
  });

  it('treats expiry as exclusive at the boundary', () => {
    // A suspension "until 12:00" is over at 12:00. Inclusive would hold the
    // account an extra tick and, worse, make the boundary untestable.
    expect(isActionActive(row({ expiresAt: new Date(NOW) }), NOW)).toBe(false);
  });
});

describe('resolveEnforcementState', () => {
  it('leaves a clean account fully capable', () => {
    const state = resolveEnforcementState([], NOW);
    expect(state).toMatchObject({
      canGenerate: true,
      canWrite: true,
      canAccess: true,
      mostSevere: null,
    });
    expect(restrictionNotice(state)).toBeNull();
  });

  it('does not restrict anything for a warning or a content removal', () => {
    // The point of these rungs: they are on the record without stopping the
    // next generation. An account whose video was removed is not thereby banned.
    for (const action of ['warning', 'content_removed'] as const) {
      const state = resolveEnforcementState([row({ action })], NOW);
      expect(state.canGenerate).toBe(true);
      expect(state.canWrite).toBe(true);
      expect(restrictionNotice(state)).not.toBeNull();
    }
  });

  it('stops generation but keeps the account writable when paused', () => {
    const state = resolveEnforcementState(
      [row({ action: 'generation_suspended' })],
      NOW
    );
    expect(state).toMatchObject({
      canGenerate: false,
      canWrite: true,
      canAccess: true,
    });
  });

  it('makes a suspended account read-only', () => {
    const state = resolveEnforcementState(
      [row({ action: 'account_suspended' })],
      NOW
    );
    expect(state).toMatchObject({
      canGenerate: false,
      canWrite: false,
      canAccess: true,
    });
  });

  it('removes access for a terminated account', () => {
    const state = resolveEnforcementState(
      [row({ action: 'account_terminated' })],
      NOW
    );
    expect(state.canAccess).toBe(false);
  });

  it('reports the most severe live action when several apply', () => {
    const state = resolveEnforcementState(
      [
        row({ id: 'warn', action: 'warning' }),
        row({ id: 'ban', action: 'account_suspended' }),
        row({ id: 'pause', action: 'generation_suspended' }),
      ],
      NOW
    );
    expect(state.mostSevere?.id).toBe('ban');
    expect(state.active).toHaveLength(3);
    expect(state.canWrite).toBe(false);
  });

  it('lets a lesser live action govern once the worst one expires', () => {
    const state = resolveEnforcementState(
      [
        row({
          id: 'ban',
          action: 'account_suspended',
          expiresAt: new Date(NOW.getTime() - 1),
        }),
        row({ id: 'pause', action: 'generation_suspended' }),
      ],
      NOW
    );
    expect(state.mostSevere?.id).toBe('pause');
    expect(state.canWrite).toBe(true);
    expect(state.canGenerate).toBe(false);
  });

  it('names the action and category in the notice, and nothing about the reporter', () => {
    const state = resolveEnforcementState(
      [
        row({
          action: 'generation_suspended',
          reason: 'deepfake_impersonation',
        }),
      ],
      NOW
    );
    const notice = restrictionNotice(state);
    expect(notice).toContain('deepfake impersonation');
    expect(notice).toContain('paused');
  });

  it('produces a notice for every action type', () => {
    // Guards the exhaustive switch: adding a rung without wording would leave a
    // restricted user staring at a bare error.
    const actions: EnforcementActionType[] = [
      'warning',
      'content_removed',
      'generation_suspended',
      'account_suspended',
      'account_terminated',
    ];
    for (const action of actions) {
      const state = resolveEnforcementState([row({ action })], NOW);
      expect(restrictionNotice(state)).toBeTruthy();
    }
  });
});

describe('assertions', () => {
  it('passes a clean account through', () => {
    const state = resolveEnforcementState([], NOW);
    expect(() => assertCanGenerate(state)).not.toThrow();
    expect(() => assertCanWrite(state)).not.toThrow();
  });

  it('throws ACCOUNT_RESTRICTED with the action and an appeal route', () => {
    const state = resolveEnforcementState(
      [row({ action: 'generation_suspended' })],
      NOW
    );
    try {
      assertCanGenerate(state);
      expect.unreachable('expected assertCanGenerate to throw');
    } catch (error) {
      // `instanceof` is sound here because the throw is live and in-process;
      // across the server-fn boundary callers must branch on `errorCode()`
      // instead (see src/lib/errors.ts).
      expect(error).toBeInstanceOf(AccountRestrictedError);
      assert(error instanceof AccountRestrictedError);
      expect(error.code).toBe('ACCOUNT_RESTRICTED');
      expect(error.statusCode).toBe(403);
      expect(error.details).toMatchObject({
        action: 'generation_suspended',
        appealPath: '/report',
      });
    }
  });

  it('still allows writes when only generation is paused', () => {
    const state = resolveEnforcementState(
      [row({ action: 'generation_suspended' })],
      NOW
    );
    expect(() => assertCanWrite(state)).not.toThrow();
  });
});
