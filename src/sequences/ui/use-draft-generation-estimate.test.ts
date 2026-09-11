/**
 * Draft estimate is public (catalog rates, no secrets) so the anonymous
 * composer can show ~$x.xx. It must still not fire on an empty script.
 */

import { describe, expect, it, vi } from 'vitest';

const estimateDraftGenerationFn = vi.fn();
vi.doMock('@/billing/pricing.fn', () => ({ estimateDraftGenerationFn }));

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
  it('fires with a script even without a session', () => {
    lastQuery = {};
    useDraftGenerationEstimate(INPUT);
    expect(lastQuery.enabled).toBe(true);
  });

  it('stays off when the script is empty', () => {
    lastQuery = {};
    useDraftGenerationEstimate({ ...INPUT, script: '   ' });
    expect(lastQuery.enabled).toBe(false);
  });
});
