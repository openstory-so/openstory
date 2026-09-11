/**
 * The composer is anonymous-browsable; `estimateDraftGenerationFn` is not.
 * Firing it logged-out 401s at error level on every debounced keystroke
 * (same class as useSequences, #1333 / #1575).
 */

import { describe, expect, it, vi } from 'vitest';

const estimateDraftGenerationFn = vi.fn();
vi.doMock('@/billing/pricing.fn', () => ({ estimateDraftGenerationFn }));

const sessionRef: { current: unknown } = { current: null };
vi.doMock('@/platform/ui/auth/session-query', () => ({
  useAuthSession: () => ({ data: sessionRef.current }),
}));

type QueryOpts = { enabled?: boolean };
let lastQuery: QueryOpts = {};
vi.doMock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOpts) => {
    lastQuery = options;
    return { data: undefined };
  },
}));

vi.doMock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: <T>(init: T) => [init, vi.fn()] as [T, (value: T) => void],
    useEffect: () => undefined,
  };
});

const { useDraftGenerationEstimate } =
  await import('./use-draft-generation-estimate');

const INPUT = {
  script: 'INT. LAUNDROMAT - NIGHT',
  imageModels: ['nano_banana_2_lite'],
  videoModels: ['minimax_h3_max'],
  audioModels: ['lyria_2'],
  aspectRatio: '9:16' as const,
  stopAt: 'motion' as const,
  generateStartFrames: false,
};

describe('useDraftGenerationEstimate', () => {
  it('does not fire the authed fn without a session', () => {
    sessionRef.current = null;
    lastQuery = {};
    useDraftGenerationEstimate(INPUT);
    expect(lastQuery.enabled).toBe(false);
  });

  it('fires once there is a session and a script', () => {
    sessionRef.current = { user: { id: 'u1' } };
    lastQuery = {};
    useDraftGenerationEstimate(INPUT);
    expect(lastQuery.enabled).toBe(true);
  });

  it('stays off when the script is empty even with a session', () => {
    sessionRef.current = { user: { id: 'u1' } };
    lastQuery = {};
    useDraftGenerationEstimate({ ...INPUT, script: '   ' });
    expect(lastQuery.enabled).toBe(false);
  });
});
