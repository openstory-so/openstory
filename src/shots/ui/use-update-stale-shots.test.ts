/** Pins that a dialogue-only update is reported in the completion toast (#1740). */

import { beforeEach, expect, test, vi } from 'vitest';

const success = vi.fn();
const error = vi.fn();
const outcome = {
  state: 'complete',
  result: {
    totalShots: 1,
    visualPrompts: 0,
    motionPrompts: 0,
    images: 0,
    dialogue: 1,
    videos: 0,
    musicPrompts: 0,
    musicTracks: 0,
    failures: [] as Array<{ shotId: string; stage: string; error: string }>,
    skipped: [],
  },
};
vi.doMock('sonner', () => ({
  toast: { success, error, info: vi.fn(), warning: vi.fn() },
}));
vi.doMock('react', () => ({
  useState: () => ['run-id', vi.fn()],
  useRef: () => ({ current: 0 }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => effect(),
}));
vi.doMock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: outcome, dataUpdatedAt: 1 }),
}));
vi.doMock('@/shots/shots.fn', () => ({
  getUpdateStaleShotsRunFn: vi.fn(),
  updateStaleShotsFn: vi.fn(),
}));
vi.doMock('@/shots/ui/use-shot-staleness', () => ({
  shotStalenessNamespace: ['staleness'],
}));
const { useUpdateStaleShots } = await import('./use-update-stale-shots');
beforeEach(() => {
  success.mockClear();
  error.mockClear();
  outcome.result.failures = [];
});
test('counts a dialogue-only update in the success toast', () => {
  useUpdateStaleShots({ sequenceId: 'sequence' });
  expect(success).toHaveBeenCalledWith('Updated 1 item across 1 shot');
});
test('reports a partial dialogue failure instead of a success', () => {
  outcome.result.failures = [
    { shotId: 'failed', stage: 'dialogue', error: 'recording failed' },
  ];
  useUpdateStaleShots({ sequenceId: 'sequence' });
  expect(success).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith('Updated 1 item, 1 could not be updated', {
    description: 'recording failed',
  });
});
