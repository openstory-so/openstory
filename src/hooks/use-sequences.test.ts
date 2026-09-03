/**
 * `useCreateSequence` must forward the WHOLE validated input to the server.
 *
 * It used to hand-copy a field list, and a field missing from that list failed
 * silently in the worst way: the composer set it, the hook dropped it, and the
 * server's Zod `.default()` supplied a value nobody chose. `generateStartFrames` (then `referenceOnly`)
 * shipped that way — the toggle rendered, persisted to localStorage, priced
 * itself into the quote, and every sequence still wrote `reference_only = 0`.
 * Nothing threw, so the only symptom was the full image pipeline running in a
 * mode that is supposed to skip it.
 */

import { describe, expect, it, vi } from 'vitest';

type CreateCall = { data: Record<string, unknown> };
const createSequenceFn = vi.fn<(args: CreateCall) => Promise<unknown[]>>(
  async () => []
);
vi.doMock('@/functions/sequences', () => ({ createSequenceFn }));
// `useMutation` returns its own options object, so `mutationFn` is callable
// straight off the hook — a pure payload check needs no React renderer. Kept
// here (not a shared helper) because it is a lie only this file wants.
const mutationOptions = new WeakMap<object, MutationOptions>();
type MutationOptions = { mutationFn: (input: unknown) => Promise<unknown> };
vi.doMock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: (options: MutationOptions) => {
    const handle = {};
    mutationOptions.set(handle, options);
    return handle;
  },
  useQuery: () => ({ data: undefined }),
}));

/** The `mutationFn` the hook handed to `useMutation`. */
function mutationFnOf(hookResult: object): MutationOptions['mutationFn'] {
  const options = mutationOptions.get(hookResult);
  if (!options) throw new Error('useMutation was not called by the hook');
  return options.mutationFn;
}
vi.doMock('@posthog/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.doMock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.doMock('@/lib/auth/session-query', () => ({
  useAuthSession: () => ({ data: null }),
}));

const { useCreateSequence } = await import('./use-sequences');

/** Every field the composer can set, with values distinct from the server defaults. */
const INPUT = {
  teamId: 'team_1',
  script: 'INT. LAUNDROMAT - NIGHT',
  styleId: 'style_1',
  title: 'Firefly Courier',
  aspectRatio: '9:16' as const,
  analysisModels: ['gpt_5_6_luna'],
  imageModels: ['nano_banana_2_lite'],
  videoModel: 'minimax_h3_max',
  videoModels: ['minimax_h3_max'],
  autoGenerateMotion: true,
  autoGenerateMusic: false,
  generateStartFrames: false,
  targetDurationSeconds: 30,
  suggestedTalentIds: ['talent_1'],
  suggestedLocationIds: ['loc_1'],
};

describe('useCreateSequence forwards the full input', () => {
  it('sends every field the caller set, generateStartFrames included', async () => {
    createSequenceFn.mockClear();
    await mutationFnOf(useCreateSequence())(INPUT);

    const sent = createSequenceFn.mock.calls[0]?.[0];
    expect(sent).toBeDefined();

    // The regression that shipped: dropped silently, defaulted away.
    expect(sent?.data.generateStartFrames).toBe(false);

    // And the general rule — nothing the caller set may go missing.
    for (const [key, value] of Object.entries(INPUT)) {
      expect(sent?.data[key]).toEqual(value);
    }
  });

  it('still defaults a blank title rather than sending one', async () => {
    createSequenceFn.mockClear();
    await mutationFnOf(useCreateSequence())({ ...INPUT, title: '' });

    const sent = createSequenceFn.mock.calls[0]?.[0];
    expect(sent?.data.title).toBe('Untitled Sequence');
    expect(sent?.data.generateStartFrames).toBe(false);
  });
});
